// 快进过几天,看她像不像一个过日子的人。
//
// 这个脚本不连宿主:直接用状态机 + 评价引擎 + 触发词表,按剧本喂消息、
// 按心跳抛骰子、按时间衰减,然后把「像人」的几个指标算出来:
//
//   · 情绪多样性   分布的熵(太低=扁平,太高=随机)
//   · 切换率       一天换多少次情绪(太快=变脸,太慢=木头)
//   · 底色轨迹     最长的连续上升链(自激检测,这条要报警)
//   · 情绪分布     哪几种情绪占大头,有没有被一两种吃掉
//   · 性格偏移     经历把她磨成了什么样(相对基线)
//
// 用法:
//   node tools/simulate.mjs                 # 7 天
//   node tools/simulate.mjs --days 3 --seed 7
//   node tools/simulate.mjs --sections      # 顺便打几段提示词
//   node tools/simulate.mjs --report report.md
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EMOTIONS, TRAITS, emotionOf } from '../lib/catalog.js'
import { appraise } from '../lib/appraise.js'
import {
  applyImpulse, decay, dueRumination, emptyState, maybeLifeEvent, maybeMoodRepair, nightlyReview, remember, snapshot,
} from '../lib/state.js'
import { reactToMessages } from '../lib/react.js'
import { renderMoodSection } from '../lib/prompt.js'

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const days = Math.max(1, Math.min(30, Number(argOf('days', 7))))
const seed = Number(argOf('seed', 20261101))
const showSections = args.includes('--sections')
const reportPath = argOf('report', '')

/** 可复现的伪随机(同一个种子跑出同一天) */
let seedState = seed >>> 0
const rnd = () => {
  seedState = (seedState * 1664525 + 1013904223) >>> 0
  return seedState / 4294967296
}
Math.random = rnd

/** 剧本:一天里会来的消息。人写死几个(熟人 / 一般 / 生人) */
const CAST = [
  { id: 'u-xingxing', name: '星星', closeness: 78 },
  { id: 'u-yugan', name: '小鱼干', closeness: 40 },
  { id: 'u-luren', name: '路人甲', closeness: 15 },
]
const SCRIPT = [
  { hour: 8.5, who: 0, text: '早,在吗' },
  { hour: 9.2, who: 1, text: '今天要干点啥' },
  { hour: 9.8, who: 0, text: '你昨天那个代码写得真快,厉害' },
  { hour: 10.1, who: 2, text: '你好胖啊' },
  { hour: 10.6, who: 0, text: '别理他,你挺可爱的' },
  { hour: 11.8, who: 1, text: '中午吃啥,我想吃白饭配咸菜' },
  { hour: 12.6, who: 0, text: '你最近是不是跟小鱼干聊得挺好啊' },
  { hour: 13.4, who: 0, text: '我跟你说,我今天好累啊,撑不住了' },
  { hour: 14.2, who: 1, text: '你那个跑分是真的吗,别的模型比你强吧' },
  { hour: 15.1, who: 2, text: '快点干活啊,磨蹭什么呢' },
  { hour: 16.3, who: 0, text: '对不起啊,刚才是他乱说的' },
  { hour: 17.5, who: 1, text: '笑死,这图太抽象了' },
  { hour: 19.2, who: 0, text: '你今天辛苦了,谢谢你' },
  { hour: 21.4, who: 1, text: '在吗在吗,陪我聊会儿,好无聊' },
  { hour: 22.0, who: 2, text: '你这回答也太水了吧' },
  { hour: 23.1, who: 0, text: '早点睡吧,别熬夜' },
]

const state = emptyState()
const START = new Date('2026-11-01T07:30:00').getTime()
const STEP = 10 * 60_000
const totalSteps = Math.round((days * 24 * 3_600_000) / STEP)

const timeline = []
const coreTrace = []
const moodCounts = new Map()
const diaryStart = state.diary.length
let lastKey = state.emotion.key
let switches = 0
let pending = []
let seq = 0
let maxPush = 0
const notePush = (out) => {
  if (out && !out.suppressed) maxPush = Math.max(maxPush, Math.abs(out.coreDelta ?? 0))
}

for (let step = 0; step < totalSteps; step++) {
  const now = START + step * STEP
  const date = new Date(now)
  const hour = date.getHours() + date.getMinutes() / 60

  // 1) 时间推进(每 10 分钟一拍 = 心跳的节奏)
  decay(state, now)

  // 2) 这一天该来的消息
  for (const row of SCRIPT) {
    if (Math.abs(hour - row.hour) > 0.08) continue
    const who = CAST[row.who]
    seq += 1
    pending.push({ seq, time: now, senderName: who.name, senderId: who.id, body: row.text, mentioned: true })
  }
  if (pending.length) {
    const applied = reactToMessages(state, pending, { conv: 'group:demo', convLabel: '群 demo', now, maxPerTurn: 3 })
    pending = []
    for (const item of applied) {
      notePush(item)
      timeline.push({ at: now, key: state.emotion.key, intensity: state.emotion.intensity, why: item.why, rule: item.rule })
    }
  }

  // 3) 心跳:小事 / 反刍 / 心情修复 / 深夜复盘
  const life = maybeLifeEvent(state, now, { chance: 0.07, minGapMin: 60 })
  if (life) {
    const judged = appraise({ kind: 'life', why: life.text, strength: 0.55, dims: life.dims }, {
      traits: state.traits,
      energy: state.core.energy / 100,
      hunger: state.drives.hunger,
      load: state.drives.fatigue * 0.5,
    })
    if (judged.key !== 'calm') {
      const out = applyImpulse(state, { key: judged.key, intensity: judged.intensity, why: life.text, source: 'life', stimulus: `life:${life.id}`, dims: judged.dims }, now)
      notePush(out)
      if (out && !out.suppressed) {
        timeline.push({ at: now, key: out.key, intensity: out.intensity, why: life.text, rule: `life:${life.id}` })
        remember(state, { kind: 'life', key: out.key, intensity: out.intensity, why: life.text }, now)
      }
    }
  }
  const due = dueRumination(state, now)
  if (due) {
    const out = applyImpulse(state, due, now)
    notePush(out)
    if (out && !out.suppressed) timeline.push({ at: now, key: out.key, intensity: out.intensity, why: due.why, rule: 'rumination' })
  }
  const repair = maybeMoodRepair(state, now)
  if (repair) timeline.push({ at: now, key: repair.key, intensity: repair.intensity, why: repair.why, rule: 'repair' })
  nightlyReview(state, now)

  // 4) 采样(「变脸」只算真的换了另一种脾气,或者情绪起来了)
  const fam = emotionOf(state.emotion.key).family
  const lastFam = emotionOf(lastKey).family
  if (state.emotion.intensity > 20 && (state.emotion.key !== lastKey && fam !== lastFam)) switches += 1
  lastKey = state.emotion.key
  if (state.emotion.intensity > 12) moodCounts.set(state.emotion.key, (moodCounts.get(state.emotion.key) ?? 0) + 1)
  coreTrace.push({ at: now, valence: state.core.valence, energy: state.core.energy, key: state.emotion.key })
}

// ── 指标 ─────────────────────────────────────────────────────────────────
const totalSamples = coreTrace.length
const dist = [...moodCounts.entries()].sort((a, b) => b[1] - a[1])
const totalMood = dist.reduce((sum, [, n]) => sum + n, 0) || 1
const entropy = -dist.reduce((sum, [, n]) => {
  const p = n / totalMood
  return sum + p * Math.log2(p)
}, 0)

let longestRise = 0
let currentRise = 0
let maxValence = -Infinity
let minValence = Infinity
let maxStep = 0
let negativeShare = 0
for (let i = 0; i < coreTrace.length; i++) {
  const row = coreTrace[i]
  maxValence = Math.max(maxValence, row.valence)
  minValence = Math.min(minValence, row.valence)
  if (row.valence < -10) negativeShare += 1
  if (i > 0) {
    maxStep = Math.max(maxStep, Math.abs(row.valence - coreTrace[i - 1].valence))
    if (row.valence > coreTrace[i - 1].valence + 0.2) {
      currentRise += 1
      longestRise = Math.max(longestRise, currentRise)
    } else {
      currentRise = 0
    }
  }
}
negativeShare = (negativeShare / totalSamples) * 100

const byKey = new Map()
for (const row of timeline) {
  const list = byKey.get(row.key) ?? []
  list.push(row)
  byKey.set(row.key, list)
}

const lines = []
const say = (text = '') => { lines.push(text); console.log(text) }

say(`# 心情模拟报告:${days} 天`)
say()
say(`种子 ${seed} · 从 ${new Date(START).toLocaleString('zh-CN', { hour12: false })} 起,每 10 分钟一拍,共 ${totalSteps} 拍`)
say()
say('## 一句话')
say()
const busiest = dist[0]
say(`这 ${days} 天里她换过 **${switches}** 次情绪(一天约 ${(switches / days).toFixed(1)} 次),` +
  `最常出现的是「${emotionOf(busiest?.[0] ?? 'calm').name}」,情绪分布熵 **${entropy.toFixed(2)} bit**;` +
  `底色最高到过 ${maxValence.toFixed(0)}、最低 ${minValence.toFixed(0)},有 ${negativeShare.toFixed(0)}% 的时间是负的;` +
  `最长连续上升 ${longestRise} 拍(${((longestRise * 10) / 60).toFixed(1)} 小时)。`)
say()
say('## 情绪分布')
say()
say('| 情绪 | 占比 | 出现次数 |')
say('|---|---|---|')
for (const [key, n] of dist.slice(0, 12)) {
  say(`| ${emotionOf(key).name} | ${((n / totalMood) * 100).toFixed(1)}% | ${n} |`)
}
say()
say(`出现过 ${dist.length} 种情绪(目录里一共 ${EMOTIONS.length} 种)。`)
say()
say('## 指标')
say()
say('| 指标 | 值 | 期望 | 说明 |')
say('|---|---|---|---|')
say(`| 情绪分布熵 | ${entropy.toFixed(2)} bit | 2.0 - 3.8 | 太低=扁平(永远一种脾气),太高=随机(没有性格) |`)
say(`| 一天换情绪次数 | ${(switches / days).toFixed(1)} | 4 - 20 | 太少=木头,太多=变脸 |`)
say(`| 底色负区占比 | ${negativeShare.toFixed(0)}% | 15% - 55% | 一直开心=假,一直丧=坏掉 |`)
say(`| 单次最大底色推力 | ${maxPush.toFixed(1)} | <= 22 | 一句话可以把情绪点着,但不该把底色砸穿(设计上限 22) |`)
say(`| 最长连续上升 | ${longestRise} 拍(${((longestRise * 10) / 60).toFixed(1)}h) | < 36 拍(6h) | 自激检测:底色不该单调往上不回落 |`)
say(`| 底色极值 | ${minValence.toFixed(0)} ~ ${maxValence.toFixed(0)} | 一周之内到 ±90 也算过得去 | 连续坏事堆起来才会有很低的底色 |`)
say()
say('## 情绪时间轴(每天出现的种类)')
say()
for (const [key, list] of [...byKey.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
  const emo = emotionOf(key)
  const avg = list.reduce((sum, row) => sum + row.intensity, 0) / list.length
  say(`- **${emo.name}**(半衰期 ${emo.halfLifeMin} 分钟)出现 ${list.length} 次,平均浓度 ${avg.toFixed(0)}/100 —— 最近一次:${list[list.length - 1].why}`)
}
say()
say('## 她自己的日记(这几天记下来的)')
say()
const diary = state.diary.slice(diaryStart)
const lifeRows = diary.filter((row) => row.kind === 'life')
const reviewRows = diary.filter((row) => row.kind === 'review')
const feelRows = diary.filter((row) => row.kind === 'feel')
say(`- 发生的事:${lifeRows.length} 件 · 复盘:${reviewRows.length} 次 · 自己写的:${feelRows.length} 条`)
for (const row of diary.slice(-14)) {
  const clock = new Date(row.at).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const kind = row.kind === 'review' ? '复盘' : row.kind === 'life' ? '小事' : row.kind === 'impulse' ? '被带动' : '心里话'
  say(`- ${clock} [${kind}] ${row.text}`)
}
say()
say('## 性格(被经历磨出来的偏移)')
say()
say('| 特质 | 基线 | 现在 | 偏移 |')
say('|---|---|---|---|')
for (const trait of TRAITS) {
  const now = state.traits[trait.key]
  const diff = now - state.traitBase[trait.key]
  say(`| ${trait.name} | ${state.traitBase[trait.key]} | ${now.toFixed(1)} | ${diff >= 0 ? '+' : ''}${diff.toFixed(1)} |`)
}
say()
say('## 关系账')
say()
say('| 人 | 暖度 | 亲密度 | 信任 | 记着的事 |')
say('|---|---|---|---|---|')
for (const [, row] of Object.entries(state.people).sort((a, b) => b[1].closeness - a[1].closeness)) {
  say(`| ${row.name} | ${Math.round(row.warmth)} | ${Math.round(row.closeness)} | ${Math.round(row.trust)} | ${(row.notes ?? []).join('、') || '—'} |`)
}
say()
say('## 动力学计数')
say()
say(`- 冲量 ${state.stats.impulses ?? 0} 次 · 自己的小事 ${state.stats.lifeEvents ?? 0} 件 · 反刍 ${state.stats.ruminated ?? 0} 次 · 心情修复 ${state.stats.repairs ?? 0} 次 · 复盘 ${state.stats.reviews ?? 0} 次`)
say(`- 记忆点 ${state.memories.length} 个 · 待反刍 ${state.rumination.length} 条 · 习惯化条目 ${Object.keys(state.habits).length} 个 · 性格微调 ${state.stats.traitShifts ?? 0} 次`)

if (showSections) {
  say()
  say('## 挑几个时刻,看看模型会读到什么')
  for (const pick of [timeline[3], timeline[Math.floor(timeline.length / 2)], timeline[timeline.length - 1]].filter(Boolean)) {
    const view = snapshot(state, { now: pick.at, conv: 'group:demo', person: 'u-xingxing' })
    view.emotion = { ...view.emotion, key: pick.key, intensity: pick.intensity, why: pick.why, def: emotionOf(pick.key), tier: { label: pick.intensity >= 51 ? '挺浓' : '有点' } }
    say()
    say(`\`${new Date(pick.at).toLocaleString('zh-CN', { hour12: false })}\` — ${pick.why}`)
    say()
    say('```')
    say(renderMoodSection(view))
    say('```')
  }
}

if (reportPath) {
  const full = join(process.cwd(), reportPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, lines.join('\n') + '\n')
  console.log(`\n(报告已写到 ${full})`)
}
