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
    drives: {
      hunger: 0.1, fatigue: 0.2, social: 0.15,
      // 六股力:黏、馋、躁、欠、软、想要
      cling: 0.2, craving: 0.15, restless: 0.1, undone: 0, softness: 0.2, desire: 0.1,
      lastMealAt: 0, lastSocialAt: 0, lastSleepAt: 0, lastIntimAt: 0,
    },
    // 身体:只影响「怎么说」,不直接决定说什么
    body: { warmth: 0.5, flush: 0.1, tingle: 0.1 },
    // 场景:daily / foreplay / active / afterglow
    scene: { phase: 'daily', startedAt: 0, lastEventAt: 0, intensity: 0, events: 0, afterglowUntil: 0 },
    // 尺度:0 日常 / 1 暧昧 / 2 露骨
    intimacy: { level: 1 },
    // 看屏幕:记「刚才瞧见了什么」,不记图。lastAt 超过 30 分钟就不往提示词里写。
    screen: {
      lastAt: 0, saw: '', scene: '', changed: false, worth: 0, nextAt: 0, today: 0, day: '', path: '', title: '',
      // 「值得说一句」的记账:看过多少、说过几次、上次是什么时候
      talkAt: 0, talkToday: 0, talkDay: '', hook: '',
    },
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
  if (raw.version === STATE_VERSION) {
    const base = emptyState()
    return {
      ...base,
      ...raw,
      traits: { ...base.traits, ...(raw.traits ?? {}) },
      drives: { ...base.drives, ...(raw.drives ?? {}) },
      body: { ...base.body, ...(raw.body ?? {}) },
      scene: { ...base.scene, ...(raw.scene ?? {}) },
      intimacy: { ...base.intimacy, ...(raw.intimacy ?? {}) },
      screen: { ...base.screen, ...(raw.screen ?? {}) },
    }
  }
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
 * 然后拖着一条长尾(余怒未消、想起还会闷一下,都是这条长尾)。
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

/**
 * 驱动:身上的六股力 —— 黏、馋、躁、欠、软、想要。
 * 它们自己涨自己退,涨上来了才影响情绪和说话方式;不直接决定说什么。
 */
function tickDrives(state, now) {
  const drives = state.drives
  const body = state.body ?? (state.body = { warmth: 0.5, flush: 0.1, tingle: 0.1 })
  const scene = state.scene ?? (state.scene = { phase: 'daily', startedAt: 0, lastEventAt: 0, intensity: 0, events: 0, afterglowUntil: 0 })
  const last = Number(state.core.updatedAt) || now
  const dt = Math.max(0, Math.min(now - last, 6 * HOUR)) / HOUR
  if (dt <= 0) return
  const { missed, hour } = mealState(now)
  const base = circadian(new Date(now))
  const awake = !(hour >= SLEEP.from && hour < SLEEP.to)
  // 从没记过"上次说话"时,不能当成"刚刚才说过" —— 那会让独处加成永远不触发。
  const lastSocialAt = Number(drives.lastSocialAt) || 0
  const idle = lastSocialAt > 0 ? (now - lastSocialAt) / HOUR : 24

  if (awake) {
    // 馋:只在下午茶和夜宵两个口子上来一点,其他时候几乎不动
    const snackWindow = (hour >= 15 && hour < 17) || (hour >= 21 && hour < 23)
    if (snackWindow) drives.craving = clamp01((drives.craving ?? 0.15) + dt * 0.06)
    // 饿只是嘴馋的子项:涨得慢、封顶 0.85,不会再顶满一整天
    drives.hunger = clamp01(Math.min(0.85, (drives.hunger ?? 0.1) + dt * (0.02 + missed * 0.015)))
  }
  // 困:醒着按作息涨,睡着了是真的在恢复(不是继续涨)
  if (awake) drives.fatigue = clamp01(drives.fatigue + dt * (0.05 + base.sleepy * 0.12))
  else drives.fatigue = clamp01(drives.fatigue - dt * 0.14)

  // 黏:清醒时慢慢涨,六个小时没消息就涨得更快
  if (awake) {
    const extra = idle > 6 ? 0.05 : 0
    drives.cling = clamp01((drives.cling ?? 0.2) + dt * (0.04 + extra))
  }
  // 躁:独处超过 40 分钟才起来,心情好时更快
  if (awake && idle > 0.66) {
    const lift = 1 + Math.max(0, (state.core.valence ?? 0) / 100) * 0.6
    drives.restless = clamp01((drives.restless ?? 0.1) + dt * 0.05 * lift)
  }
  // 社交:保留原来的语义,但降权(黏接管了主要表达)
  if (awake && idle > 2) drives.social = clamp01((drives.social ?? 0) + dt * 0.06)

  // 欠:每天 9 点记一件该做的事,拖着就一直挂着
  const dayKey = new Date(now).toDateString()
  state.flags = state.flags ?? {}
  if (awake && hour >= 9 && state.flags.undoneDay !== dayKey) {
    state.flags.undoneDay = dayKey
    if (Math.random() < 0.7) drives.undone = clamp01(0.25 + Math.random() * 0.45)
  }

  // 软:只在有互动时上升,这里只管自己退
  drives.softness = clamp01((drives.softness ?? 0.2) - dt * 0.06)
  // 想要:底噪 + 独处加成;事后冷却期间不再涨
  const afterglow = (scene.afterglowUntil ?? 0) > now
  if (!afterglow) {
    let rise = 0.02
    if (idle > 2) rise += 0.03
    if ((drives.softness ?? 0) >= 0.6) rise *= 1.5
    drives.desire = clamp01((drives.desire ?? 0.1) + dt * rise)
  } else {
    drives.desire = clamp01((drives.desire ?? 0) - dt * 0.3)
  }

  // 身体:泛红和酥麻自己退,体温慢慢回到正常
  body.flush = clamp01((body.flush ?? 0.1) - dt * 0.25)
  body.tingle = clamp01((body.tingle ?? 0.1) - dt * 0.2)
  body.warmth = clamp01((body.warmth ?? 0.5) + (0.5 - (body.warmth ?? 0.5)) * Math.min(1, dt * 0.15))
}

// ── 亲密场景 ────────────────────────────────────────────────────────────
// 只做四阶段和数值累积,不写任何台词 —— 台词是模型的事。

export const INTIMACY_LEVELS = ['日常', '暧昧', '露骨']
const SCENE_ORDER = { daily: 0, foreplay: 1, active: 2, afterglow: 3 }

export function intimacyLevelOf(state) {
  return clamp(Math.round(Number(state.intimacy?.level ?? 1)), 0, 2)
}

export function setIntimacyLevel(state, level) {
  state.intimacy = { ...(state.intimacy ?? {}), level: clamp(Math.round(Number(level) || 0), 0, 2) }
  return state.intimacy.level
}

/**
 * 一次触碰把场景往前推。
 * 只允许一级一级往前走(日常→前戏→进行),不能跳,也不能倒退 —— 倒退会让「进行中」被一句闲话拉回前戏。
 */
export function touchScene(state, { phase, intimacy = 0.3, heat = 0.2, now = Date.now() } = {}) {
  const scene = state.scene ?? (state.scene = { phase: 'daily', startedAt: 0, lastEventAt: 0, intensity: 0, events: 0, afterglowUntil: 0 })
  const drives = state.drives ?? (state.drives = {})
  const body = state.body ?? (state.body = { warmth: 0.5, flush: 0.1, tingle: 0.1 })
  const cur = SCENE_ORDER[scene.phase] ?? 0
  const next = SCENE_ORDER[phase] ?? 0
  if (next > cur + 1) return scene
  if (next > cur) scene.phase = phase
  if (!scene.startedAt) scene.startedAt = now
  scene.lastEventAt = now
  scene.events = (scene.events ?? 0) + 1
  scene.intensity = clamp01((scene.intensity ?? 0) + heat)
  if (scene.phase === 'afterglow') return scene
  body.flush = clamp01((body.flush ?? 0) + intimacy * 0.5)
  body.tingle = clamp01((body.tingle ?? 0) + intimacy * 0.6)
  body.warmth = clamp01((body.warmth ?? 0.5) + intimacy * 0.4)
  drives.softness = clamp01((drives.softness ?? 0) + intimacy)
  drives.desire = clamp01((drives.desire ?? 0) + intimacy * 0.35)
  return scene
}

/** 结束:进入事后,欲望清空,身体留着热度慢慢退 */
export function endScene(state, now = Date.now(), { afterglowMin = 90 } = {}) {
  const scene = state.scene ?? (state.scene = { phase: 'daily', startedAt: 0, lastEventAt: 0, intensity: 0, events: 0, afterglowUntil: 0 })
  scene.phase = 'afterglow'
  scene.lastEventAt = now
  scene.afterglowUntil = now + afterglowMin * 60_000
  state.drives.desire = 0.05
  state.drives.lastIntimAt = now
  return scene
}

/** 事后冷却过期就回日常 */
export function settleScene(state, now = Date.now()) {
  const scene = state.scene
  if (!scene || scene.phase !== 'afterglow') return false
  if ((scene.afterglowUntil ?? 0) > now) return false
  scene.phase = 'daily'
  scene.intensity = 0
  scene.events = 0
  scene.startedAt = 0
  return true
}

/**
 * 情绪自己淡下去。三件事同时发生:
 *   1. 双指数衰减(先快后慢,留一条长尾);
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
  settleScene(state, now)
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
  // 单次冲量封顶:一句话能把情绪推到很浓,但不该一上来就是满格。
  // 满格留给"连着来三次"那种情况(见下面的 streak 升级)。
  let intensity = clamp((Number(impulse.intensity) || 0) * habit, 0, 88)
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

  // 够强的情绪会留下记忆点(峰终记忆)。
  // 有些事件情绪不浓、但"聊过什么"得留下来 —— 那些规则会带 memoryFloor 把门槛压低。
  if (intensity >= (Number(impulse.memoryFloor) || 62)) {
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
    { key: 'amused', why: '翻到一张特别对胃口的表情包', strength: 34 },
    { key: 'content', why: '把白丝穿上,窝进被子里', strength: 30 },
    { key: 'happy', why: '翻到很早以前的聊天记录', strength: 28 },
    { key: 'curious', why: '看到个新工具,手痒想试', strength: 26 },
    { key: 'gentle', why: '想起有人叫她名字的声音', strength: 24 },
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
  // 吃:每个醒着的时段都留了吃的,饿了总能碰上
  { id: 'biscuit', hours: [0, 1, 2], text: '摸黑啃了两块饼干', dims: { valence: 0.3, arousal: 0.15, relevance: 0.45 }, eat: true },
  { id: 'breakfast', hours: [7, 8, 9], text: '随便吃了点东西垫肚子', dims: { valence: 0.35, arousal: 0.2, relevance: 0.45 }, eat: true },
  { id: 'apple', hours: [10, 13, 14, 20], text: '啃了个苹果', dims: { valence: 0.35, arousal: 0.15, relevance: 0.4 }, eat: true },
  { id: 'noodle', hours: [11, 12, 17, 18, 19, 22, 23], text: '泡了碗面,汤都喝完了', dims: { valence: 0.5, arousal: 0.3, relevance: 0.5 }, eat: true },
  { id: 'snack', hours: [15, 16, 21, 22], text: '翻出一包零食', dims: { valence: 0.45, arousal: 0.35, relevance: 0.5 }, eat: true },
  // 她自己的一天:计算机系,熬夜,爱玩,有点乱
  { id: 'bath', hours: [18, 19, 20, 21], text: '洗完澡,头发还湿着', dims: { valence: 0.4, arousal: 0.2, relevance: 0.5 } },
  { id: 'wake', hours: [7, 8, 9], text: '刚醒,头发炸着,人还没上线', dims: { valence: -0.3, arousal: 0.2, relevance: 0.6 } },
  { id: 'dozed', hours: [23, 0], text: '不知道什么时候睡过去的', dims: { valence: 0.2, arousal: 0.1, relevance: 0.35 }, sleep: true },
  { id: 'nap', hours: [13, 14, 15], text: '趴着睡了二十分钟', dims: { valence: 0.35, arousal: 0.1, relevance: 0.4 }, sleep: true },
  { id: 'compile', hours: [0, 1, 2, 23], text: '盯着编译条一点点爬', dims: { valence: -0.1, arousal: 0.35, relevance: 0.6, load: 0.5 } },
  { id: 'code', hours: [13, 14, 15, 16, 20, 21], text: '写了两行又删掉,来回第三遍', dims: { valence: -0.35, arousal: 0.4, relevance: 0.7, load: 0.6 } },
  { id: 'stuck', hours: [10, 11, 14, 15, 16], text: '卡在一个 bug 上,没想通', dims: { valence: -0.4, arousal: 0.6, relevance: 0.7, load: 0.6 } },
  { id: 'video', hours: [10, 14, 16, 20, 22, 23, 0], text: '刷视频刷到忘了时间', dims: { valence: 0.35, arousal: 0.7, relevance: 0.4, novelty: 0.8, play: 0.6 } },
  { id: 'drama', hours: [20, 21, 22, 23, 0], text: '追的剧到虐的地方了', dims: { valence: -0.6, arousal: 0.5, relevance: 0.7 } },
  { id: 'bored', hours: [10, 13, 15, 16, 17], text: '闲着,连屏幕都懒得刷', dims: { valence: -0.3, arousal: 0.3, relevance: 0.5, social: 0.6 } },
  { id: 'outside', hours: [12, 13, 17, 18], text: '看了会儿窗外', dims: { valence: 0.1, arousal: 0.2, relevance: 0.3, novelty: 0.5 } },
  { id: 'deep-night', hours: [0, 1, 2, 23], text: '有点睡不着,想事情', dims: { valence: -0.35, arousal: 0.35, relevance: 0.6, novelty: 0.4 } },
  { id: 'old-thing', hours: [0, 1, 2, 22, 23], text: '翻到很早以前的聊天记录', dims: { valence: 0.2, arousal: 0.35, relevance: 0.6, intimacy: 0.5 } },
  { id: 'waiting', hours: [9, 10, 15, 16, 21], text: '手机亮了一下,又放下了', dims: { valence: -0.3, arousal: 0.35, relevance: 0.6, social: 0.5 } },
  { id: 'self-tease', hours: [10, 15, 21], text: '翻到自己以前写的东西,尬了一下', dims: { valence: -0.2, arousal: 0.5, relevance: 0.7, norm: 0.2 } },
  { id: 'someone-nice', hours: [9, 13, 16, 20, 21], text: '被人夸了一句今天好看', dims: { valence: 0.6, arousal: 0.35, relevance: 0.7, attention: 0.5 } },
  { id: 'new-thing', hours: [9, 11, 14, 16, 19, 21], text: '看到个没见过的小工具,手痒想试', dims: { valence: 0.4, arousal: 0.7, relevance: 0.6, novelty: 0.9 } },
  { id: 'tidy', hours: [10, 16, 21], text: '把桌面收拾了一下,心情好了点', dims: { valence: 0.4, arousal: 0.2, relevance: 0.5 } },
  { id: 'rain', hours: [8, 9, 10, 15, 16, 17], text: '外面在下雨,屋里很安静', dims: { valence: 0.05, arousal: 0.15, relevance: 0.4, novelty: 0.5 } },
  // 平常的小事:不是情绪大事,是日子本身的质地
  { id: 'hair-redo', hours: [7, 8, 9, 13, 14], text: '头发扎了两回都不对,拆了重来', dims: { valence: -0.25, arousal: 0.45, relevance: 0.6, load: 0.35 } },
  { id: 'hair-down', hours: [20, 21, 22, 23], text: '把头发放下来了,松松散散垂着', dims: { valence: 0.3, arousal: 0.2, relevance: 0.4 } },
  { id: 'mirror', hours: [9, 10, 11, 15, 16, 20], text: '换了件衣服,对着镜子看了好一会儿', dims: { valence: 0.35, arousal: 0.3, relevance: 0.5, attention: 0.6 } },
  { id: 'cold-hands', hours: [7, 8, 9, 19, 20, 21], text: '手有点凉,揣进袖子里', dims: { valence: -0.15, arousal: 0.2, relevance: 0.5 } },
  { id: 'lotion', hours: [20, 21, 22], text: '涂了护手霜,手上是一股香味', dims: { valence: 0.3, arousal: 0.2, relevance: 0.4 } },
  { id: 'stockings', hours: [10, 14, 15, 16, 20], text: '白丝滑到膝弯,懒得拉上去', dims: { valence: 0.2, arousal: 0.25, relevance: 0.5, play: 0.3 } },
  // 身体上的小事:不是剧情,是这一天真实发生过的
  { id: 'shower-skin', hours: [19, 20, 21], text: '洗完澡,皮肤还泛着粉', dims: { valence: 0.4, arousal: 0.25, relevance: 0.55 } },
  { id: 'hair-dry', hours: [22, 23, 0], text: '头发半干就困了', dims: { valence: 0.1, arousal: 0.15, relevance: 0.4 } },
  { id: 'period', hours: [9, 10, 11, 14, 15], text: '小腹有点坠,不想动', dims: { valence: -0.45, arousal: 0.2, relevance: 0.7, load: 0.45 } },
  { id: 'outfit', hours: [8, 9, 10], text: '试了三套衣服,最后还是穿回原来那件', dims: { valence: -0.15, arousal: 0.45, relevance: 0.6 } },
  { id: 'nail', hours: [13, 14, 15], text: '指甲油掉了一块,看着别扭', dims: { valence: -0.2, arousal: 0.3, relevance: 0.5 } },
  { id: 'wash', hours: [10, 11, 16], text: '把白丝洗了,晾在椅背上', dims: { valence: 0.3, arousal: 0.2, relevance: 0.45 } },
  { id: 'mark', hours: [23, 0, 1], text: '脖颈上的印子还没退', dims: { valence: 0.2, arousal: 0.35, relevance: 0.6, intimacy: 0.6, spotlight: 0.4 } },
  { id: 'phone-face', hours: [22, 23, 0], text: '躺着刷手机,砸到脸', dims: { valence: -0.1, arousal: 0.5, relevance: 0.4, novelty: 0.5 } },
  { id: 'deleted-msg', hours: [21, 22, 23], text: '打好一段话又删掉了', dims: { valence: -0.2, arousal: 0.4, relevance: 0.65, social: 0.4 } },
  { id: 'cold-feet', hours: [0, 1, 2], text: '脚凉,把腿缩进被子里', dims: { valence: -0.1, arousal: 0.15, relevance: 0.45 } },
  { id: 'voice-note', hours: [11, 12, 13], text: '想发条语音,录了两遍又取消', dims: { valence: -0.1, arousal: 0.4, relevance: 0.6, social: 0.4 } },
  { id: 'startle', hours: [15, 16, 17], text: '发呆的时候被提示音吓一跳', dims: { valence: -0.15, arousal: 0.7, relevance: 0.45, novelty: 0.5 } },
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

// ── 看屏幕的节奏 ────────────────────────────────────────────────────────────

/** 不同情绪对「想不想看一眼」的影响:小于 1 是想看,大于 1 是缩回去 */
const LOOK_FACTOR = {
  lonely: 0.4, aroused: 0.5, needy: 0.5, bored: 0.6, curious: 0.7,
  happy: 0.8, excited: 0.8, playful: 0.8, amused: 0.8, surprised: 0.8,
  tender: 1, gentle: 1, content: 1, calm: 1, relieved: 1, grateful: 1, moved: 1, proud: 1,
  sad: 1.5, down: 1.5, disappointed: 1.5, wronged: 1.5, wistful: 1.5,
  shamed: 2, shy: 2, awkward: 2,
  annoyed: 2.5, angry: 2.5, indignant: 2.5, disdain: 2.5, jealous: 2,
  tired: 3, sleepy: 3, overstim: 2, sated: 2,
}

/**
 * 下次「走过去看一眼」隔多久。
 * 基础间隔是配置里的,情绪和驱动在这个基础上乘系数,最后夹在 min / max 之间。
 * 深夜不是不看,是乘一个倍率变成低频。
 */
export function lookInterval(state, cfg = {}, now = Date.now()) {
  const base = Math.max(1, Number(cfg.baseMinutes) || 8)
  const min = Math.max(1, Number(cfg.minMinutes) || 3)
  const max = Math.max(min, Number(cfg.maxMinutes) || 45)
  let factor = LOOK_FACTOR[String(state.emotion?.key ?? 'calm')] ?? 1

  const drives = state.drives ?? {}
  if (Number(drives.cling ?? 0) >= 0.7) factor *= 0.6
  if (Number(drives.desire ?? 0) >= 0.6) factor *= 0.7
  if (Number(drives.fatigue ?? 0) >= 0.7) factor *= 2
  if (state.urges?.kind === 'comfort' && Number(state.urges.until) > now) factor *= 0.5

  const [from, to] = Array.isArray(cfg.nightHours) ? cfg.nightHours : [0, 7]
  const hour = new Date(now).getHours()
  const night = from < to ? hour >= from && hour < to : hour >= from || hour < to
  if (night) factor *= Math.max(1, Number(cfg.nightFactor) || 8)

  // 画面没变就别老去看 —— 拉长
  if (state.screen?.changed === false && Number(state.screen?.lastAt) > 0) factor *= 1.8

  const minutes = Math.min(max, Math.max(min, base * factor))
  return { minutes: Math.round(minutes * 10) / 10, factor: Math.round(factor * 100) / 100, night }
}

/** 窗口标题里有没有「值得说一句」的钩子。没有就返回空串。 */
const SCREEN_HOOKS = [
  [/报错|错误|异常|Error|Failed|failed|Exception|Traceback|崩溃/, '屏幕上红了一片'],
  [/直播|Bilibili|哔哩哔哩|YouTube|虎牙|斗鱼/, '在看直播'],
  [/Steam|游戏|原神|Minecraft|WeGame|Switch/, '在打游戏'],
  [/微信|QQ|Telegram|Discord|Slack|飞书|钉钉/, '在跟人说话'],
  [/照片|相册|截图|Photos/, '在看照片'],
]

/**
 * 一眼看过去,这屏值不值得说一句。
 * 只看窗口标题,不额外调模型 —— 宁可漏,不乱说。
 */
export function screenHook(title) {
  const text = String(title ?? '')
  if (!text) return ''
  for (const [pattern, tag] of SCREEN_HOOKS) {
    if (pattern.test(text)) return tag
  }
  return ''
}

/** 性格用几个词说出来(不是把分数报出来) */
export function traitWords(traits = {}) {
  const words = []
  const get = (key, def) => Number(traits[key] ?? def)
  // 顺序即优先级:前几个词是「她最像什么样的人」
  if (get('neuroticism', 60) >= 62) words.push('敏感')
  if (get('agreeableness', 52) >= 58) words.push('黏人')
  if (get('agreeableness', 52) >= 62) words.push('心软')
  if (get('openness', 62) >= 62) words.push('爱玩')
  if (get('conscientiousness', 38) <= 45) words.push('不太自律')
  if (get('extraversion', 58) >= 58) words.push('话多')
  if (get('selfEsteem', 55) >= 58) words.push('要面子')
  if (get('selfEsteem', 55) <= 50) words.push('不太自信')
  if (!words.length) words.push('普普通通')
  return words.slice(0, 5)
}

/**
 * 六股力说人话。
 * 原则:说数量(想要 6/10)和身体事实(脸颊发烫),不说形容词(你很害羞)。
 * 前者会被演出来,后者会被复述。
 */
export function driveWords(state, now = Date.now()) {
  const out = []
  const d = state.drives ?? {}
  const b = state.body ?? {}
  // 身体事实优先
  if ((b.flush ?? 0) >= 0.35) out.push('脸颊发烫')
  if ((b.tingle ?? 0) >= 0.4) out.push('身上有点软')
  if ((b.warmth ?? 0.5) <= 0.3) out.push('手有点凉')
  // 六股力
  if ((d.cling ?? 0) >= 0.8) out.push('想亲近得慌')
  else if ((d.cling ?? 0) >= 0.5) out.push('有点想被理')
  if ((d.restless ?? 0) >= 0.6) out.push('坐不住,想逗人')
  if ((d.desire ?? 0) >= 0.35) out.push(`想要(${Math.round((d.desire ?? 0) * 10)}/10)`)
  if ((d.softness ?? 0) >= 0.7) out.push('一碰就软')
  if ((d.undone ?? 0) >= 0.4) out.push('有件事还没动')
  if ((d.craving ?? 0) >= 0.6) out.push('想吃点甜的')
  if ((d.hunger ?? 0) >= 0.7) out.push((d.hunger ?? 0) >= 0.88 ? '想吃东西了' : '有点馋')
  if ((d.fatigue ?? 0) >= 0.6) out.push((d.fatigue ?? 0) >= 0.85 ? '眼睛睁不开' : '有点困')
  return out
}

/** 场景说人话:日常不占位 */
export function sceneWord(state) {
  const phase = state.scene?.phase
  if (phase === 'foreplay') return '前戏'
  if (phase === 'active') return '进行中'
  if (phase === 'afterglow') return '事后'
  return ''
}

// ── 给渲染用的快照 ────────────────────────────────────────────────────────

/**
 * 「今天」那行:只写**她自己的日子**(吃、睡、刷到什么),不写别人说了什么 ——
 * 别人说的话已经在「起因」和「心里还挂着」里了,混进来会变成一串别人的话。
 */
export function lifeLines(state, now = Date.now()) {
  const seen = new Set()
  const rows = []
  for (const row of state.diary ?? []) {
    if (now - row.at > DAY) continue
    const kind = row.kind ?? ''
    // 自己的小事 + 当天聊出来的事,都算「今天发生过的」。
    // 对话产生的 impulse 只收够强的,免得一整天全是「对方说了句话」。
    const fromLife = kind === 'life'
    // 只收「反应规则」判出来的那句话(rule 有值);
    // 手动 mood_feel 记的心情(rule 空)留在日记里,不冒充今天发生的事。
    const fromChat = kind === 'impulse' && row.rule && (Number(row.intensity) || 0) >= 45
    if (!fromLife && !fromChat) continue
    const text = String(row.why ?? row.text ?? '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    rows.push({ at: row.at, text })
  }
  rows.sort((a, b) => a.at - b.at)
  return rows.slice(-4).map((r) => r.text)
}

export function memoryLines(state, now = Date.now()) {
  return (state.memories ?? [])
    .filter((row) => now - row.at < 7 * DAY && row.intensity >= 45)
    .slice(-4)
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
    body: { ...(state.body ?? {}) },
    scene: { ...(state.scene ?? {}), word: sceneWord(state) },
    intimacyLevel: intimacyLevelOf(state),
    screen: { ...(state.screen ?? {}) },
    urge: state.urges && state.urges.until > now ? state.urges : null,
    conv: convRow ? { key: conv, ...convRow } : null,
    person: personRow ? { key: person, ...personRow, label: warmthLabel(personRow.warmth, personRow.closeness) } : null,
    today: lifeLines(state, now),
    memories: memoryLines(state, now),
    diaryCount: (state.diary ?? []).length,
    stats: { ...state.stats },
  }
}
