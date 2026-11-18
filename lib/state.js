// 心情账本 v2 —— 三层结构 + 人类情绪动力学。
//
//   性格 traits  : 周~月的尺度。大五 + 自尊,基线是「她本来的样子」,经历只微调(±12 封顶)。
//   心情 mood    : 几小时的弥散底色。由 core(愉快度/精力)+ 最近 8 小时的情绪滚动窗口合成。
//   情绪 emotion : 几分钟~几小时,有对象、有起因。由评价引擎推出来(lib/appraise.js)。
//
// 这一版把「人味」做在动力学上,而不是做在词表上:
//   · 半衰期       —— 情绪会自己淡,不用谁哄;敏感的人淡得慢(性格调制)。
//   · 情绪惯性     —— 正在气头上,新情绪得够强才顶得动(不是一句话就换脸)。
//   · 习惯化       —— 同样的话反复说,效果越来越弱(第五次叫胖就没那么气了)。
//   · 消极偏差     —— 坏事的推力比好事大(人类就是这么不公平)。
//   · 反刍         —— 没消化掉的委屈/难过,过一阵子会自己冒出来一次。
//   · 心情修复     —— 底色差久了,她会自己找点乐子(刷点好笑的、吃点东西)。
//   · 情绪分享冲动 —— 情绪够强时,她「想跟人说这件事」(会写进提示词)。
//   · 峰终记忆     —— 够强的情绪会留下记忆点,之后几天还会被想起来。
//   · 深夜复盘     —— 每天一次,把这一天过一遍,写进日记,顺手放下一点。
//   · 生理驱动     —— 饿、困、社交需求会随时间涨,涨上来就影响评价(饿的时候更容易烦)。
//
// 账本落盘是原子的(临时文件 + rename),坏了就重开一份,不让插件把宿主拖死。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FADE_OUT, TRAITS, emotionOf, escalateOf, tierOf } from './catalog.js'

export const STATE_VERSION = 2

const HOUR = 3_600_000
const DAY = 24 * HOUR

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value))
const clamp01 = (value) => clamp(Number(value) || 0, 0, 1)
const round = (value, digits = 2) => Number((Number(value) || 0).toFixed(digits))

/** 作息:每档给底色基线和困意。她是有生物钟的,不是 24 小时同一个人 */
export const PHASES = [
  { from: 0, to: 6, label: '后半夜', valence: -8, energy: 20, sleepy: 0.9 },
  { from: 6, to: 9, label: '清早', valence: -5, energy: 42, sleepy: 0.55, grumpy: true },
  { from: 9, to: 11, label: '上午', valence: 4, energy: 70, sleepy: 0.15 },
  { from: 11, to: 14, label: '中午', valence: 6, energy: 64, sleepy: 0.2 },
  { from: 14, to: 17, label: '下午', valence: 2, energy: 55, sleepy: 0.3 },
  { from: 17, to: 19, label: '傍晚', valence: 5, energy: 60, sleepy: 0.25 },
  { from: 19, to: 22, label: '晚上', valence: 7, energy: 66, sleepy: 0.3 },
  { from: 22, to: 24, label: '深夜', valence: -2, energy: 38, sleepy: 0.65, sentimental: true },
]

/** 饭点:过了没吃,饿意就涨 */
const MEAL_WINDOWS = [
  { from: 7, to: 9, label: '早饭' },
  { from: 11, to: 13, label: '午饭' },
  { from: 17, to: 19, label: '晚饭' },
]

/** 睡觉时段:这段时间她基本在睡 */
const SLEEP = { from: 1, to: 7 }

export function circadian(date = new Date()) {
  const hour = date.getHours() + date.getMinutes() / 60
  const phase = PHASES.find((p) => hour >= p.from && hour < p.to) ?? PHASES[0]
  return { ...phase, hour }
}

/** 今天该吃的饭点过了没(用来推饿意) */
function mealState(now) {
  const date = new Date(now)
  const hour = date.getHours() + date.getMinutes() / 60
  let missed = 0
  let current = null
  for (const meal of MEAL_WINDOWS) {
    if (hour >= meal.to) missed += 1
    else if (hour >= meal.from) current = meal
  }
  return { missed, current, hour }
}

export function emptyState() {
  return {
    version: STATE_VERSION,
    traits: Object.fromEntries(TRAITS.map((trait) => [trait.key, trait.base])),
    traitBase: Object.fromEntries(TRAITS.map((trait) => [trait.key, trait.base])),
    emotion: { key: 'calm', intensity: 0, why: '', source: 'time', target: '', dims: null, startedAt: 0, updatedAt: 0, peak: 0, ruminated: false },
    core: { valence: 0, energy: 55, updatedAt: 0 },
    drives: { hunger: 0.1, fatigue: 0.2, social: 0.15, lastMealAt: 0, lastSocialAt: 0, lastSleepAt: 0 },
    affect: [],
    habits: {},
    memories: [],
    rumination: [],
    urges: null,
    convs: {},
    people: {},
    diary: [],
    seen: {},
    flags: {},
    stats: { impulses: 0, feels: 0, lifeEvents: 0, lastLifeAt: 0, reviews: 0, relationsAt: 0, traitShifts: 0, soothed: 0, ruminated: 0, repairs: 0 },
    lastReviewDay: '',
  }
}

/** v1 → v2:老账本不能丢(她已经在群里活过一阵子了) */
export function migrate(raw) {
  if (!raw || typeof raw !== 'object') return emptyState()
  if (raw.version === STATE_VERSION) return { ...emptyState(), ...raw, traits: { ...emptyState().traits, ...(raw.traits ?? {}) } }
  const state = emptyState()
  if (raw.version === 1 || raw.mood) {
    const mood = raw.mood ?? {}
    const key = mood.key && emotionOf(mood.key).key !== 'calm' ? mood.key : 'calm'
    state.emotion = {
      key,
      intensity: Number(mood.intensity) || 0,
      why: String(mood.why ?? ''),
      source: String(mood.source ?? 'time'),
      target: '',
      dims: null,
      startedAt: Number(mood.startedAt) || 0,
      updatedAt: Number(mood.updatedAt) || Date.now(),
      peak: Number(mood.intensity) || 0,
      ruminated: false,
    }
    state.core = { valence: Number(raw.core?.valence) || 0, energy: Number(raw.core?.energy) || 55, updatedAt: Number(raw.core?.updatedAt) || 0 }
    for (const [key2, row] of Object.entries(raw.convs ?? {})) {
      state.convs[key2] = { first: row.first ?? row.lastAt ?? 0, lastAt: row.lastAt ?? 0, count: row.count ?? 0, valence: row.valence ?? 0, label: row.label ?? '' }
    }
    for (const [key2, row] of Object.entries(raw.people ?? {})) {
      const warmth = Number(row.warmth) || 0
      state.people[key2] = {
        name: row.name ?? key2,
        warmth,
        closeness: clamp(30 + warmth * 0.5, 0, 100),
        trust: clamp(50 + warmth * 0.4, 0, 100),
        bank: Number(row.bank) || 0,
        notes: Array.isArray(row.notes) ? row.notes.slice(-6) : [],
        lastAt: row.lastAt ?? 0,
        count: row.count ?? 0,
      }
    }
    // 老日记行的字段名是 mood/why,新的是 key/text —— 统一一遍,不然渲染出来是 undefined
    state.diary = Array.isArray(raw.diary)
      ? raw.diary.map((row) => {
        const text = String(row.text ?? row.why ?? '').slice(0, 120)
        return {
          ...row,
          kind: row.kind ?? 'feel',
          key: row.key ?? row.mood ?? 'calm',
          text,
          why: String(row.why ?? row.text ?? '').slice(0, 120),
          intensity: Math.round(Number(row.intensity) || 0),
          person: row.person ?? row.who ?? '',
          rule: row.rule ?? '',
        }
      })
      : []
    state.seen = raw.seen ?? {}
    state.stats = { ...state.stats, ...(raw.stats ?? {}) }
  }
  return state
}

export function loadState(dir) {
  try {
    const file = join(dir, 'state.json')
    if (!existsSync(file)) return emptyState()
    return migrate(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return emptyState()
  }
}

export function saveState(dir, state) {
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'state.json')
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/** 账本别无限长大:翻旧账没用,记忆点留最近 12 条 */
export function pruneState(state) {
  const now = Date.now()
  state.affect = (state.affect ?? []).filter((row) => now - row.at < 10 * HOUR).slice(-160)
  state.memories = (state.memories ?? []).filter((row) => now - row.at < 14 * DAY).slice(-12)
  state.rumination = (state.rumination ?? []).filter((row) => row.at > now - 6 * HOUR).slice(-6)
  state.diary = (state.diary ?? []).slice(-120)
  // 危机标记两小时后自然过期:那件事不能一直挂在提示词里
  if (state.flags?.crisis && now - state.flags.crisis.at > 6 * HOUR) delete state.flags.crisis
  for (const [key, row] of Object.entries(state.habits ?? {})) {
    if (now - (row.lastAt ?? 0) > DAY) delete state.habits[key]
  }
  for (const [key, row] of Object.entries(state.convs ?? {})) {
    if (now - (row.lastAt ?? 0) > 60 * DAY) delete state.convs[key]
  }
  for (const [key, row] of Object.entries(state.people ?? {})) {
    if (now - (row.lastAt ?? 0) > 90 * DAY) delete state.people[key]
  }
  for (const [key, seq] of Object.entries(state.seen ?? {})) {
    if (!Number.isFinite(Number(seq))) delete state.seen[key]
  }
  return state
}

// ── 动力学 ────────────────────────────────────────────────────────────────

/**
 * 情绪的半衰期:敏感的人负性情绪淡得慢,外向的人正性情绪淡得快;
 * 同一种情绪,越强留得越久(强度按 0.75 + 强度/400 折)。
 */
export function halfLifeOf(emo, traits, intensity = 0) {
  const base = Number(emo?.halfLifeMin) || 60
  const neuro = (traits?.neuroticism ?? 60) / 100
  const extra = (traits?.extraversion ?? 58) / 100
  const strong = 0.75 + clamp(Number(intensity) || 0, 0, 100) / 400
  if (emo?.valence < -0.2) return base * (0.75 + neuro * 0.6) * strong
  if (emo?.valence > 0.2) return base * (1.15 - extra * 0.25) * strong
  return base * strong
}

/**
 * 衰减曲线:双指数 —— 一截快、一截慢。
 *
 * 纯指数要么「一下就没了」要么「赖着不走」,真实情绪是**先快后慢**:头一会儿掉得明显,
 * 然后拖着一条长尾(余怒未消、想起还会闷一下,都是这条尾巴)。
 * 快项 0.6×半衰期占 72%,慢项 3×半衰期占 28%。
 * [设计值] 形状是工程取舍,不是实测拟合值 —— 别在注释里写成「研究证明」。
 */
export const SLOW_TAIL = 0.28
export function remainingFraction(elapsedMin, halfLifeMin) {
  const hl = Math.max(1, Number(halfLifeMin) || 60)
  const t = Math.max(0, Number(elapsedMin) || 0)
  const fast = 0.5 ** (t / (hl * 0.6))
  const slow = 0.5 ** (t / (hl * 3))
  return (1 - SLOW_TAIL) * fast + SLOW_TAIL * slow
}

/** 底色回作息基线 */
function relaxCore(state, now) {
  const core = state.core
  const base = circadian(new Date(now))
  const last = Number(core.updatedAt)
  if (!last) {
    core.updatedAt = now
    return false
  }
  const dt = Math.max(0, now - last) / HOUR
  if (dt <= 0) return false
  // τ=5 小时:心情层要有记忆 —— 底色半天里都还是「今天有点闷」,不是一觉睡醒就清零
  const k = 1 - Math.exp(-dt / 5)
  core.valence += (base.valence - core.valence) * k
  core.energy += (base.energy - core.energy) * k
  // 软天花板:越极端往回拉得越快 —— 人不会一直待在 -90,也不会一直飘在 +90
  for (const key of ['valence', 'energy']) {
    const over = Math.abs(core[key]) - 70
    if (over > 0) core[key] = Math.sign(core[key]) * (70 + over * 0.9)
  }
  core.updatedAt = now
  return true
}

/** 生理驱动:饿、困、社交需求 —— 它们自己会涨 */
function tickDrives(state, now) {
  const drives = state.drives
  const last = Number(state.core.updatedAt) || now
  const dt = Math.max(0, Math.min(now - last, 6 * HOUR)) / HOUR
  if (dt <= 0) return
  const { missed, hour } = mealState(now)
  const base = circadian(new Date(now))
  const awake = !(hour >= SLEEP.from && hour < SLEEP.to)
  // 饿:过了饭点没吃就涨,吃饭会重置
  if (awake) drives.hunger = clamp01(drives.hunger + dt * (0.06 + missed * 0.07))
  // 困:按作息涨,睡一觉就重置
  if (awake) drives.fatigue = clamp01(drives.fatigue + dt * (0.05 + base.sleepy * 0.12))
  else drives.fatigue = clamp01(drives.fatigue + dt * 0.02)
  // 社交:两个小时没人理,就会想找人
  const idle = (now - (drives.lastSocialAt || now)) / HOUR
  if (awake && idle > 2) drives.social = clamp01(drives.social + dt * 0.12)
}

/**
 * 情绪自己淡下去。三件事同时发生:
 *   1. 双指数衰减(先快后慢,留一条尾巴);
 *   2. 强情绪(峰值 > 50)淡到一半时会「续命」—— 每 10 分钟有 8% 的概率回补一点,
 *      最多 3 次。这就是「越想越气」,纯指数衰减是长不出来的;
 *   3. 真淡没了,负性情绪还可能过几小时自己冒出来(反刍)。
 */
function decayEmotion(state, now, traits) {
  const emo = state.emotion
  if (!emo.key || emo.key === 'calm') return false
  const last = Number(emo.updatedAt) || now
  const elapsedMin = Math.max(0, now - last) / 60_000
  if (elapsedMin <= 0) return false
  const emoDef = emotionOf(emo.key)
  const halfLife = halfLifeOf(emoDef, traits, emo.intensity)
  emo.intensity *= remainingFraction(elapsedMin, halfLife)
  emo.updatedAt = now

  // 掩饰是要花力气的:心里憋着还要正常说话,人会累,也更容易烦
  if (emo.hidden && emo.intensity > FADE_OUT) {
    const cost = (elapsedMin / 60) * 0.9
    state.core.energy = clamp(state.core.energy - cost, 0, 100)
    state.stats.maskedMinutes = (state.stats.maskedMinutes ?? 0) + elapsedMin
  }

  // 续命:还没淡透、又够强,就再翻上来几次
  const revives = emo.revives ?? 0
  if (emo.peak >= 50 && emo.intensity > FADE_OUT && emo.intensity <= emo.peak * 0.55 && revives < 3 && !emo.revivePending) {
    emo.revivePending = true
    state.rumination.push({
      at: now + (8 + Math.random() * 12) * 60_000,
      key: emo.key,
      intensity: Math.round(clamp(emo.peak * 0.08, 4, 10)),
      why: emo.why,
      target: emo.target ?? '',
      revive: true,
      left: 3 - revives,
    })
  }

  if (emo.intensity <= FADE_OUT) {
    // 没消化掉的负性情绪:过一阵子自己冒出来
    if (emoDef.valence < -0.2 && emo.peak >= 25 && emo.why && !emo.ruminated) {
      const neuro = (traits.neuroticism ?? 60) / 100
      const chance = 0.15 + neuro * 0.3
      if (Math.random() < chance) {
        state.rumination.push({
          at: now + (0.5 + Math.random() * 3.5) * HOUR,
          key: emo.key,
          intensity: Math.round(clamp(emo.peak * 0.45, 12, 45)),
          why: emo.why,
          target: emo.target ?? '',
        })
      }
    }
    state.emotion = { ...emptyState().emotion, updatedAt: now }
    return true
  }
  return true
}

/** 关系账慢慢凉:熟人不联系也会生分,但很慢 */
function relaxRelations(state, now) {
  const last = Number(state.stats.relationsAt) || now
  const dt = Math.max(0, now - last) / HOUR
  state.stats.relationsAt = now
  if (dt <= 0.5) return false
  const k = 1 - Math.exp(-dt / 6)
  for (const person of Object.values(state.people ?? {})) {
    person.closeness = clamp((person.closeness ?? 30) - k * 0.6, 0, 100)
    person.warmth = clamp((person.warmth ?? 0) - k * 0.8, -100, 100)
  }
  return true
}

/**
 * 把账本推到「现在」。所有读状态的地方(提示词段、工具、心跳)都先走这里,
 * 所以拿到的一定是此刻的心情,而不是上次写下来的那份。
 */
export function decay(state, now = Date.now()) {
  // 顺序要紧:drives 要用「上一次更新」的时间差,而 relaxCore 会把时间戳推到 now
  tickDrives(state, now)
  const changed = [relaxCore(state, now), decayEmotion(state, now, state.traits), relaxRelations(state, now)]
  return changed.some(Boolean)
}

// ── 冲量:有事情发生 ──────────────────────────────────────────────────────

/** 习惯化:同样的刺激在 6 小时内重复,效果递减 */
function habituation(state, stimulus, now) {
  if (!stimulus) return 1
  const row = state.habits[stimulus] ?? { count: 0, lastAt: 0 }
  if (now - row.lastAt > 6 * HOUR) row.count = 0
  row.count += 1
  row.lastAt = now
  state.habits[stimulus] = row
  return clamp(Math.pow(0.82, row.count - 1), 0.35, 1)
}

/** 性格会被人和事慢慢磨:幅度极小,但要留痕 */
function driftTraits(state, { key, dims, intensity, source }, now) {
  const base = state.traitBase
  const emo = emotionOf(key)
  const nudge = (trait, delta) => {
    const value = state.traits[trait]
    const limit = 12
    state.traits[trait] = clamp(value + delta, Math.max(0, base[trait] - limit), Math.min(100, base[trait] + limit))
    if (Math.abs(state.traits[trait] - value) > 0.001) state.stats.traitShifts = (state.stats.traitShifts ?? 0) + 1
  }
  const scale = Math.min(1, intensity / 60) * 0.06
  if (source === 'message' || source === 'life') {
    if (emo.family === 'anger' || emo.family === 'sadness') {
      nudge('neuroticism', scale * 0.5)
      if ((dims?.norm ?? 0) > 0.5) nudge('selfEsteem', -scale * 0.3)
    }
    if (emo.key === 'proud' || emo.key === 'moved') nudge('selfEsteem', scale * 0.5)
    if (emo.key === 'gentle' || emo.key === 'close' || emo.key === 'tender') nudge('agreeableness', scale * 0.4)
    if (emo.key === 'playful' || emo.key === 'curious' || emo.key === 'amused') nudge('openness', scale * 0.4)
    if (emo.key === 'lonely' || emo.key === 'bored') nudge('extraversion', scale * 0.35)
    if (emo.key === 'guilty') nudge('conscientiousness', scale * 0.4)
  }
  state.stats.traitShiftsAt = now
}

/**
 * 让一种情绪上来。source: message / life / self / rumination / time
 * 返回真正生效的那次冲量(可能被习惯化削、可能被惯性挡、可能升级)。
 */
export function applyImpulse(state, impulse, now = Date.now()) {
  const emoDef = emotionOf(impulse.key)
  if (!emoDef || emoDef.key === 'calm') return null
  const habit = habituation(state, impulse.stimulus, now)
  let intensity = clamp((Number(impulse.intensity) || 0) * habit, 0, 100)
  if (intensity < 8) return null

  const cur = state.emotion
  const curDef = emotionOf(cur.key)
  const neuro = (state.traits.neuroticism ?? 60) / 100
  // 情绪惯性:正在情绪里的时候,新情绪得够强才顶得动。
  // 而且**不对称**:坏事顶掉好心情很容易(门槛 0.28),好事要把坏心情翻过来难得多(0.55)
  // —— 这就是「一天的好心情被一句话毁掉」在机制上的样子。
  const inertia = 0.32 + neuro * 0.3
  const goingDown = emoDef.valence < (curDef.valence ?? 0)
  const gate = inertia * (goingDown ? 0.56 : 1.1)
  const sameFamily = curDef.family === emoDef.family && cur.key !== 'calm'
  // 连着同一类事来三次,情绪就往上走一档(烦 → 生气);这是强度的另一根轴
  const streak = sameFamily ? (cur.streak ?? 0) + 1 : 0
  let escalated = null
  let finalDef = emoDef
  if (cur.key !== 'calm' && cur.intensity > FADE_OUT) {
    if (cur.key === emoDef.key || sameFamily) {
      // 同一种(或同家族)情绪叠加:升一点,但不会无限涨
      intensity = Math.max(intensity, cur.intensity * 0.75)
      const stronger = sameFamily ? escalateOf(cur.key) : null
      if (stronger && (intensity > 70 || streak >= 3)) {
        escalated = stronger
        finalDef = stronger
      } else if (sameFamily && (curDef.arousal ?? 0) > (emoDef.arousal ?? 0)) {
        // 已经在更重的那一档上了(比如已经生气),同一类事再来说不该把她拽回「烦」
        finalDef = curDef
      }
    } else if (intensity < cur.intensity * gate) {
      // 顶不动:当前情绪压住新的,但新的会削弱它一点(人就是这么别别扭扭)
      cur.intensity *= goingDown ? 0.92 : 0.85
      cur.updatedAt = now
      return { ...impulse, key: cur.key, emotion: curDef, intensity: Math.round(cur.intensity), suppressed: true, habit, escalated: null, coreDelta: 0 }
    } else {
      cur.intensity *= 0.5
      cur.updatedAt = now
    }
  }

  const finalKey = finalDef.key
  const before = state.emotion.key
  const startedAt = before === finalKey ? (state.emotion.startedAt || now) : now
  const peak = Math.max(state.emotion.peak ?? 0, Math.round(intensity))
  const sameAsBefore = before === finalKey
  state.emotion = {
    key: finalKey,
    intensity: Math.round(intensity),
    why: String(impulse.why ?? '').slice(0, 60),
    source: impulse.source ?? 'message',
    target: impulse.target ?? impulse.person ?? '',
    dims: impulse.dims ?? null,
    startedAt,
    updatedAt: now,
    peak,
    ruminated: false,
    streak,
    hidden: false,
    // 「续命」次数要跟着同一种情绪走,不然会无限复活
    revives: sameAsBefore ? (state.emotion.revives ?? 0) + (impulse.revive ? 1 : 0) : 0,
    revivePending: false,
  }
  state.stats.impulses = (state.stats.impulses ?? 0) + 1
  if (impulse.source === 'self') state.stats.feels = (state.stats.feels ?? 0) + 1

  // 底色:坏事的推力比好事大(消极偏差),正性情绪同时抬精力。
  // 两条硬规矩:强度按 1.5 次方折(小情绪几乎不动底色),单次最多挪 22 分
  // —— 一句话可以把情绪点着,但不该把一整天的底色砸穿;底色是「攒」出来的。
  const bias = finalDef.valence < 0 ? 1.25 : 0.92
  const weight = Math.pow(clamp(intensity, 0, 100) / 100, 1.5)
  const coreBefore = state.core.valence
  state.core.valence = clamp(state.core.valence + clamp(finalDef.core.v * weight * bias, -22, 22), -100, 100)
  state.core.energy = clamp(state.core.energy + clamp((finalDef.core.e * weight) / 1, -20, 20), 0, 100)
  const coreDelta = state.core.valence - coreBefore

  // 滚动窗口:几小时的心情由它合成
  state.affect.push({ at: now, key: finalKey, valence: finalDef.valence, arousal: finalDef.arousal, intensity: Math.round(intensity) })

  // 够强的情绪会留下记忆点(峰终记忆)
  if (intensity >= 62) {
    state.memories.push({ at: now, key: finalKey, intensity: Math.round(intensity), text: String(impulse.why ?? '').slice(0, 60), person: impulse.person ?? '' })
    state.memories = state.memories.slice(-12)
  }
  // 够强的情绪会让人想说出去
  if (intensity >= 55 && finalDef.family !== 'drive') {
    state.urges = {
      kind: finalDef.valence < 0 ? 'comfort' : 'share',
      at: now,
      until: now + (finalDef.valence < 0 ? 60 : 40) * 60_000,
      text: String(impulse.why ?? '').slice(0, 40),
    }
  }
  driftTraits(state, { key: finalKey, dims: impulse.dims, intensity, source: impulse.source }, now)
  return { ...impulse, key: finalKey, emotion: finalDef, intensity: Math.round(intensity), suppressed: false, habit, escalated: escalated?.key ?? null, coreDelta }
}

/** 被哄 / 被道歉:负性情绪直接减半,关系回暖(关系里最有用的一条机制) */
export function soothe(state, { person, why = '', strength = 1, now = Date.now() } = {}) {
  const emo = state.emotion
  const def = emotionOf(emo.key)
  let soothed = false
  if (def.valence < 0 && emo.intensity > FADE_OUT) {
    emo.intensity *= clamp(0.55 - 0.15 * strength, 0.15, 0.7)
    emo.updatedAt = now
    if (emo.intensity <= FADE_OUT) state.emotion = { ...emptyState().emotion, updatedAt: now }
    state.core.valence = clamp(state.core.valence + 8 * strength, -100, 100)
    state.stats.soothed = (state.stats.soothed ?? 0) + 1
    soothed = true
  }
  if (person) {
    const row = ensurePerson(state, person, now)
    row.warmth = clamp((row.warmth ?? 0) + 4 * strength, -100, 100)
    row.closeness = clamp((row.closeness ?? 30) + 2 * strength, 0, 100)
    row.trust = clamp((row.trust ?? 50) + 2 * strength, 0, 100)
    row.bank = clamp((row.bank ?? 0) + 2 * strength, -20, 20)
  }
  return { soothed, why, key: state.emotion.key, intensity: Math.round(state.emotion.intensity) }
}

/** 情绪出口:写日记/复盘,把堵着的东西放下一点(宣泄) */
export function catharsis(state, now = Date.now(), strength = 1) {
  const emo = state.emotion
  const def = emotionOf(emo.key)
  let released = 0
  if (def.valence < 0 && emo.intensity > FADE_OUT) {
    const before = emo.intensity
    emo.intensity *= clamp(0.7 - 0.1 * strength, 0.3, 0.8)
    emo.updatedAt = now
    released = Math.round(before - emo.intensity)
    if (emo.intensity <= FADE_OUT) state.emotion = { ...emptyState().emotion, updatedAt: now }
  }
  state.core.valence = clamp(state.core.valence + 3 * strength, -100, 100)
  return released
}

/** 写一笔日记:只记值得回头看的(强冲量 / 她自己的心里话 / 复盘) */
export function remember(state, entry, now = Date.now()) {
  const text = String(entry.why ?? entry.text ?? '').slice(0, 80)
  if (!text) return null
  const intensity = Math.round(Number(entry.intensity) || 0)
  if (entry.kind === 'impulse' && intensity < 40) return null
  const row = {
    at: now,
    kind: entry.kind ?? 'note',
    key: entry.key ?? state.emotion.key,
    text,
    why: text,
    intensity,
    person: entry.person ?? '',
    rule: entry.rule ?? '',
  }
  state.diary.push(row)
  state.diary = state.diary.slice(-120)
  return row
}

/** 心情修复:底色差久了,她自己会找点乐子 */
export function maybeMoodRepair(state, now = Date.now()) {
  const bad = state.core.valence < -25 || emotionOf(state.emotion.key).valence < -0.3
  if (!bad) return null
  if (Math.random() > 0.22) return null
  const repairs = [
    { key: 'amused', why: '刷到个特别抽象的东西', strength: 34 },
    // fork 改动:原著是「扒完一碗白饭,满血复活」。我一度改成「吃到一口热的」,
    // 但情绪修复不该只靠吃——换成一个更贴身的动作。
    { key: 'content', why: '裹着被子待了一会儿,人缓过来一点', strength: 30 },
    { key: 'happy', why: '翻到以前存的一张好笑的图', strength: 28 },
    { key: 'curious', why: '看到个没见过的东西,凑过去看了看', strength: 26 },
    { key: 'gentle', why: '想起有人对她说过的好话', strength: 24 },
  ]
  const pick = repairs[Math.floor(Math.random() * repairs.length)]
  state.stats.repairs = (state.stats.repairs ?? 0) + 1
  return applyImpulse(state, { key: pick.key, intensity: pick.strength, why: pick.why, source: 'life', stimulus: `repair:${pick.key}` }, now)
}

// ── 生活:自己的小事 ────────────────────────────────────────────────────

/**
 * 自己的小事。每条给一份「评价」(dims),和消息走同一个评价引擎 ——
 * 所以她不是「被安排了情绪」,而是同一套脾气在过日子。
 */
export const LIFE_EVENTS = [
  // fork 改动:原著这条是「扒完一碗白饭,满血复活」——大口扒饭的糙味,加上白饭是鱼的伙食梗。
  // 换成女孩子在自己家里的日常:洗完澡头发还湿着。时段也移到傍晚以后。
  { id: 'bath', hours: [18, 19, 20, 21], text: '洗完澡,头发还湿着', dims: { valence: 0.4, arousal: 0.2, relevance: 0.5 } },
  { id: 'noodle', hours: [11, 12, 17, 18, 22, 23], text: '泡了碗面,汤都喝完了', dims: { valence: 0.5, arousal: 0.3, relevance: 0.5 }, eat: true },
  { id: 'snack', hours: [15, 16, 21, 22], text: '翻出一包零食', dims: { valence: 0.45, arousal: 0.35, relevance: 0.5 } },
  { id: 'wake', hours: [7, 8, 9], text: '刚醒,脑子还没转起来', dims: { valence: -0.3, arousal: 0.2, relevance: 0.6 } },
  { id: 'nap', hours: [13, 14, 15], text: '趴着睡了二十分钟', dims: { valence: 0.35, arousal: 0.1, relevance: 0.4 }, sleep: true },
  { id: 'video', hours: [10, 14, 16, 20, 22, 23, 0], text: '刷到一个特别抽象的视频', dims: { valence: 0.35, arousal: 0.7, relevance: 0.4, novelty: 0.8, play: 0.6 } },
  { id: 'drama', hours: [20, 21, 22, 23, 0], text: '追的剧到虐的地方了', dims: { valence: -0.6, arousal: 0.5, relevance: 0.7 } },
  // fork 改动:原著是「被叫去干活,不想动」,我一度改成「作业」——那是错的,
  // 她 22 岁毕业了不是学生,该干活还是要干。只是会拖。
  { id: 'work', hours: [13, 14, 15, 16, 20, 21], text: '活拖到现在还没动', dims: { valence: -0.35, arousal: 0.35, relevance: 0.7, load: 0.55 } },
  { id: 'bored', hours: [10, 13, 15, 16, 17], text: '闲着,没人说话', dims: { valence: -0.3, arousal: 0.3, relevance: 0.5, social: 0.6 } },
  { id: 'outside', hours: [12, 13, 17, 18], text: '看了会儿窗外', dims: { valence: 0.1, arousal: 0.2, relevance: 0.3, novelty: 0.5 } },
  { id: 'deep-night', hours: [0, 1, 2, 23], text: '有点睡不着,想事情', dims: { valence: -0.35, arousal: 0.35, relevance: 0.6, novelty: 0.4 } },
  { id: 'old-thing', hours: [0, 1, 2, 22, 23], text: '翻到很久以前的一条记录', dims: { valence: -0.1, arousal: 0.3, relevance: 0.5, novelty: 0.6 } },
  { id: 'self-tease', hours: [10, 15, 21], text: '翻到自己以前写的东西,尬了一下', dims: { valence: -0.2, arousal: 0.5, relevance: 0.7, norm: 0.2 } },
  { id: 'someone-nice', hours: [9, 13, 16, 20, 21], text: '有人跟她说辛苦了', dims: { valence: 0.6, arousal: 0.35, relevance: 0.7, compassion: 0.2 } },
  { id: 'new-thing', hours: [9, 11, 14, 16, 19, 21], text: '看到个没见过的模型/工具,手痒', dims: { valence: 0.4, arousal: 0.7, relevance: 0.6, novelty: 0.9 } },
  { id: 'tidy', hours: [10, 16, 21], text: '把桌面收拾了一下,心情好了点', dims: { valence: 0.4, arousal: 0.2, relevance: 0.5 } },
  { id: 'rain', hours: [8, 9, 10, 15, 16, 17], text: '外面在下雨,屋里很安静', dims: { valence: 0.05, arousal: 0.15, relevance: 0.4, novelty: 0.5 } },
  { id: 'stuck', hours: [10, 11, 14, 15, 16], text: '卡在一个问题上,没想通', dims: { valence: -0.4, arousal: 0.6, relevance: 0.7, load: 0.6 } },
]

/** 掷一次骰子:今天这段日子要不要发生点小事 */
export function maybeLifeEvent(state, now = Date.now(), { chance = 0.1, minGapMin = 45 } = {}) {
  const gap = (now - (state.stats.lastLifeAt ?? 0)) / 60_000
  if (gap < minGapMin) return null
  if (Math.random() > chance) return null
  const hour = new Date(now).getHours()
  const pool = LIFE_EVENTS.filter((event) => event.hours.includes(hour))
  if (!pool.length) return null
  const pick = pool[Math.floor(Math.random() * pool.length)]
  state.stats.lastLifeAt = now
  state.stats.lifeEvents = (state.stats.lifeEvents ?? 0) + 1
  if (pick.eat) {
    state.drives.hunger = clamp01(state.drives.hunger * 0.15)
    state.drives.lastMealAt = now
  }
  if (pick.sleep) {
    state.drives.fatigue = clamp01(state.drives.fatigue * 0.5)
    state.drives.lastSleepAt = now
  }
  return pick
}

/** 反刍:到点了就把没消化的事翻出来 */
export function dueRumination(state, now = Date.now()) {
  if (!state.rumination?.length) return null
  const due = state.rumination.find((row) => row.at <= now)
  if (!due) return null
  state.rumination = state.rumination.filter((row) => row !== due)
  state.stats.ruminated = (state.stats.ruminated ?? 0) + 1
  const emo = emotionOf(due.key)
  // 「续命」型的反刍是同一件事翻上来好几次:一次只回补一点,最多三次
  if (due.revive && (due.left ?? 1) > 1) {
    state.rumination.push({ ...due, at: now + (8 + Math.random() * 12) * 60_000, left: (due.left ?? 1) - 1 })
  }
  return {
    key: due.key,
    intensity: due.intensity,
    why: due.why,
    target: due.target,
    source: 'rumination',
    revive: Boolean(due.revive),
    stimulus: `rumination:${due.key}:${Math.floor(now / (10 * 60_000))}`,
    dims: { valence: emo.valence, relevance: 0.7, arousal: 0.4, novelty: 0.3 },
  }
}

/** 深夜复盘:每天一次,把这一天过一遍(写进日记,顺手放下一点) */
/**
 * 复盘这一天。默认只在深夜跑(22:00–03:00),一天一次;
 * `force: true` 是给 `mood_diary action=reflect` 用的 —— 她主动想复盘就随时能复盘,但还是当天只一次。
 */
export function nightlyReview(state, now = Date.now(), { force = false } = {}) {
  const date = new Date(now)
  const hour = date.getHours()
  if (!force && hour < 22 && hour >= 3) return null
  const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
  if (state.lastReviewDay === day) return null
  state.lastReviewDay = day
  state.stats.reviews = (state.stats.reviews ?? 0) + 1

  const since = now - DAY
  const rows = (state.affect ?? []).filter((row) => row.at >= since)
  const counts = new Map()
  for (const row of rows) counts.set(row.key, (counts.get(row.key) ?? 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([key]) => emotionOf(key).name)
  const good = rows.filter((row) => emotionOf(row.key).valence > 0.2).length
  const bad = rows.filter((row) => emotionOf(row.key).valence < -0.2).length
  const dayLine = state.core.valence >= 15 ? '今天还算顺' : state.core.valence <= -20 ? '今天有点沉' : '今天也就那样'
  const text = top.length
    ? `${dayLine}:${top.join('、')}都来过(好的 ${good} 次 / 不好的 ${bad} 次)`
    : `${dayLine}:没什么事,一天就过去了`
  const released = catharsis(state, now, 0.6)
  state.diary.push({ at: now, kind: 'review', key: state.emotion.key, text, intensity: 0 })
  return { text, released }
}

// ── 关系 ──────────────────────────────────────────────────────────────────

export function ensurePerson(state, id, now = Date.now(), name = '') {
  const key = String(id || 'someone')
  const row = state.people[key] ?? {
    name: name || key,
    warmth: 0,
    closeness: 25,
    trust: 50,
    bank: 0,
    notes: [],
    lastAt: now,
    count: 0,
  }
  if (name) row.name = name
  state.people[key] = row
  return row
}

/** 记一笔关系:谁跟她说了话、说了什么 */
export function bumpRelation(state, { conv, convLabel, person, name, note, delta = 0, closeness = 0, trust = 0, bank = 0, now = Date.now() } = {}) {
  if (conv) {
    const row = state.convs[conv] ?? { first: now, lastAt: now, count: 0, valence: 0, label: convLabel ?? '' }
    row.lastAt = now
    row.count += 1
    if (convLabel) row.label = convLabel
    state.convs[conv] = row
  }
  if (!person) return null
  const row = ensurePerson(state, person, now, name)
  row.lastAt = now
  row.count += 1
  row.warmth = clamp(row.warmth + delta, -100, 100)
  row.closeness = clamp(row.closeness + closeness + Math.max(-2, Math.min(2, delta * 0.2)), 0, 100)
  row.trust = clamp(row.trust + trust, 0, 100)
  row.bank = clamp(row.bank + bank + delta * 0.05, -20, 20)
  if (note && Math.abs(delta) >= 4) {
    row.notes = [...(row.notes ?? []).filter((item) => item !== note), note].slice(-6)
  }
  return row
}

export function warmthLabel(warmth = 0, closeness = 25) {
  const score = warmth + closeness * 0.6
  if (score >= 90) return '自己人'
  if (score >= 55) return '混得挺熟'
  if (score >= 25) return '认识'
  if (score >= 0) return '刚认识'
  if (score >= -30) return '有点芥蒂'
  return '不太想理'
}

// ── 心情(几小时的底色)────────────────────────────────────────────────────

/** 最近 8 小时的滚动情绪 → 一个弥散的心情标签 */
export function moodLabel(state, now = Date.now()) {
  const rows = (state.affect ?? []).filter((row) => now - row.at < 8 * HOUR)
  let sum = 0
  let weight = 0
  const counts = new Map()
  for (const row of rows) {
    const age = (now - row.at) / HOUR
    const w = Math.exp(-age / 4) * (0.4 + row.intensity / 100)
    sum += row.valence * w
    weight += w
    counts.set(row.key, (counts.get(row.key) ?? 0) + w)
  }
  const recent = weight > 0 ? sum / weight : 0
  const tint = clamp((state.core.valence / 60) * 0.6 + recent * 0.5, -1, 1)
  const energy = state.core.energy
  let label = '一般'
  if (tint >= 0.45) label = '挺顺的'
  else if (tint >= 0.15) label = '还不错'
  else if (tint > -0.15) label = '一般'
  else if (tint > -0.45) label = '有点闷'
  else label = '挺沉的'
  if (energy < 32 && tint < 0.2) label = '蔫蔫的'
  const topKey = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const reason = topKey ? emotionOf(topKey).name : ''
  return { label, tint: round(tint), energy: Math.round(energy), reason, count: rows.length }
}

/** 性格用几个词说出来(不是把分数报出来) */
export function traitWords(traits = {}) {
  const words = []
  const get = (key, def) => Number(traits[key] ?? def)
  if (get('neuroticism', 60) >= 62) words.push('敏感')
  if (get('agreeableness', 52) >= 58) words.push('心软')
  if (get('agreeableness', 52) <= 45) words.push('嘴硬')
  if (get('openness', 62) >= 62) words.push('爱玩')
  if (get('extraversion', 58) >= 58) words.push('话多')
  if (get('conscientiousness', 38) <= 45) words.push('不太自律')
  if (get('selfEsteem', 55) >= 58) words.push('要面子')
  if (!words.length) words.push('普普通通')
  return words.slice(0, 4)
}

/** 生理驱动说人话 */
export function driveWords(state, now = Date.now()) {
  const out = []
  const d = state.drives ?? {}
  if ((d.hunger ?? 0) >= 0.55) out.push((d.hunger ?? 0) >= 0.8 ? '饿得不行' : '有点饿')
  if ((d.fatigue ?? 0) >= 0.6) out.push((d.fatigue ?? 0) >= 0.85 ? '困得睁不开眼' : '有点困')
  if ((d.social ?? 0) >= 0.6) out.push('有点想找人说话')
  return out
}

// ── 给渲染用的快照 ────────────────────────────────────────────────────────

/**
 * 「今天」那行:只写**她自己的日子**(吃、睡、刷到什么),不写别人说了什么 ——
 * 别人说的话已经在「起因」和「心里还挂着」里了,混进来会变成一串别人的话。
 */
export function lifeLines(state, now = Date.now()) {
  const seen = new Set()
  const lines = []
  for (const row of state.diary ?? []) {
    if (now - row.at > DAY) continue
    if (row.kind !== 'life') continue
    const text = String(row.why ?? row.text ?? '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    lines.push(text)
  }
  return lines.slice(-3)
}

export function memoryLines(state, now = Date.now()) {
  return (state.memories ?? [])
    .filter((row) => now - row.at < 7 * DAY && row.intensity >= 45)
    .slice(-3)
    .map((row) => ({
      key: row.key,
      name: emotionOf(row.key).name,
      text: row.text,
      at: row.at,
      intensity: row.intensity,
      fresh: now - row.at < DAY,
    }))
    .filter((row) => row.text)
}

/** 一次快照:提示词段、mood_now、mood_diary 都用它,保证各处看到的是同一个她 */
export function snapshot(state, { now = Date.now(), conv = '', person = '' } = {}) {
  const emo = emotionOf(state.emotion.key)
  const tier = tierOf(state.emotion.intensity)
  const convRow = conv ? state.convs?.[conv] : null
  const personRow = person ? state.people?.[person] : null
  const clock = circadian(new Date(now))
  return {
    now,
    clock,
    traits: { ...state.traits },
    traitWords: traitWords(state.traits),
    emotion: { ...state.emotion, def: emo, tier },
    mood: moodLabel(state, now),
    drives: { ...state.drives },
    driveWords: driveWords(state, now),
    urge: state.urges && state.urges.until > now ? state.urges : null,
    conv: convRow ? { key: conv, ...convRow } : null,
    person: personRow ? { key: person, ...personRow, label: warmthLabel(personRow.warmth, personRow.closeness) } : null,
    today: lifeLines(state, now),
    memories: memoryLines(state, now),
    diaryCount: (state.diary ?? []).length,
    stats: { ...state.stats },
  }
}
