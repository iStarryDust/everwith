// 评价引擎:从「刚刚发生了什么」推到「她现在是什么情绪」。
//
// 这是 v2 和 v1 最大的区别。v1 是关键词 → 情绪(叫胖 = 生气),情绪像开关;
// 人不是这么运作的:同一句「你胖」,陌生人说是冒犯(生气),熟人说可能是玩笑(好笑/委屈),
// 她今天累不累、自尊高不高、之前有没有被说过,都会改结果。
//
// 所以中间加一层「评价」(appraisal,心理学里的 appraisal theory):
//
//   事件 → 打分(这几个维度)→ 情绪
//
// 维度(全部归一化,写进 lib/catalog.js 里每种情绪的 signal):
//   valence     好受(+1)/ 难受(-1)
//   arousal     唤醒度(平/激动)
//   relevance   跟我有关吗:0 = 完全别人的事,1 = 冲着我来的
//   agency      谁的锅:'other' / 'self' / 'world' / 'none'
//   coping      我应付得了吗(能反击/能解决 = 高;只能受着 = 低)
//   norm        越界程度(这么对我不合适)
//   fairness    公平吗(-1 太不公平)
//   expectation 期望落空(-1)/ 超出预期(+1)
//   novelty     意外程度
//   certainty   确定了没有(不确定 → 紧张/困惑)
//   intimacy    对方跟我的亲密度(熟人的刀更疼,熟人的夸更让人脸红)
//   attention   有没有人看着我/在说我
//   compassion  对方在难受(共情通道:温柔/心疼/担心)
//   play        玩笑/逗乐通道
//   social      孤独感(没人理我)
//   desire      身体想要的程度(由驱动和场景算出来的,不从字面判断)
//   hunger/energy/load  内部驱动(饿/困/心累)
//
// 每个情绪在目录里带一份 signal(哪些维度、落在什么区间),这里负责打分选最像的那个。

import { EMOTIONS, emotionOf, tierOf } from './catalog.js'

const clamp01 = (value) => Math.max(0, Math.min(1, value))
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value))

/** 维度权重:越能决定情绪归属的越重 */
const WEIGHTS = {
  valence: 2.2,
  relevance: 1.4,
  agency: 1.3,
  recognition: 1.3,
  spotlight: 1.1,
  coping: 1.2,
  norm: 1.1,
  compassion: 1.2,
  fairness: 1.0,
  benefit: 1.2,
  resolution: 1.0,
  rivalry: 1.0,
  attention: 0.9,
  intimacy: 0.8,
  novelty: 0.8,
  expectation: 0.8,
  arousal: 0.8,
  play: 0.8,
  certainty: 0.6,
  selfAgency: 0.9,
  selfEsteem: 0.6,
  social: 1.5,
  desire: 1.8,
  hunger: 1.6,
  energy: 1.5,
  load: 1.3,
}

/** 单个维度的吻合度:落在区间里 = 1,越远越掉,掉到 0 为止 */
function rangeFit(value, [lo, hi]) {
  if (value === undefined || value === null || Number.isNaN(value)) return null
  if (value >= lo && value <= hi) return 1
  const span = Math.max(0.15, hi - lo)
  const distance = value < lo ? lo - value : value - hi
  return clamp01(1 - distance / span)
}

/**
 * 每个维度的「没说的时候」是什么值。
 *
 * 关键规矩:**只算事件明说的维度 + 引擎从她状态里算出来的维度**。
 * 否则像「满足」要求 `benefit: [0, 0.4]`(没占谁便宜),事件没提 benefit 时默认 0 会白送一个吻合点,
 * 情绪到处乱冒;反过来空事件也会因为 valence 默认 0 而推出一堆「烦」。
 */
const NEUTRAL = {
  valence: 0, arousal: 0.45, relevance: 0.5, norm: 0, fairness: 0, expectation: 0,
  novelty: 0.3, certainty: 0.7, intimacy: 0.2, recognition: 0, spotlight: 0, benefit: 0,
  resolution: 0, rivalry: 0, compassion: 0, play: 0, social: 0, desire: 0, hunger: 0, load: 0,
  attention: 0.5, selfEsteem: 0.55, coping: 0.5, energy: 0.5,
}

/** 这些维度是引擎按她的状态算出来的,任何时候都算数(不是「事件没说」) */
export const DERIVED_DIMS = ['coping', 'selfEsteem', 'intimacy', 'energy', 'hunger', 'load', 'social', 'desire']

/** 单个维度的吻合度:数值维度落在区间里 = 1,越远越掉;分类维度(agency 这类)只认相等 */
function fitOf(value, range) {
  if (typeof value === 'string' || typeof range === 'string') {
    const list = Array.isArray(range) ? range : [range]
    return list.some((item) => String(item) === String(value)) ? 1 : 0
  }
  return rangeFit(value, range)
}

/** 一个情绪跟这组评价有多像:0-1;gate 用来「一票否决」明显不像的 */
export function scoreEmotion(emo, dims, given = null) {
  let weightSum = 0
  let score = 0
  let hits = 0
  let evidence = 0
  let gate = 1
  for (const [rawDim, range] of Object.entries(emo.signal ?? {})) {
    // `!dim` = 这条约束必须成立:事件没说,就不认这个情绪(用来防「害羞」这种需要被看着的情绪乱冒)
    const required = rawDim.startsWith('!')
    const dim = required ? rawDim.slice(1) : rawDim
    const value = dims[dim]
    if (value === undefined || value === null) continue
    const derived = DERIVED_DIMS.includes(dim)
    const isGiven = !given || given.has(dim) || derived
    if (required && !isGiven) return { score: 0, hits: 0, evidence: 0 }
    // 事件没提到、也不是引擎算出来的维度 → 这条约束没提供信息,跳过
    if (!isGiven) continue
    const fit = fitOf(value, range)
    if (fit === null || Number.isNaN(fit)) continue
    const weight = WEIGHTS[dim] ?? 0.5
    weightSum += weight
    score += weight * fit
    hits += 1
    if (!derived) evidence += 1
    // 不符合的约束要**明显**压低分数:差得越远压得越狠
    if (fit < 0.2) gate = Math.min(gate, 0.15)
    else if (fit < 0.5) gate = Math.min(gate, 0.5)
    else if (fit < 0.8) gate = Math.min(gate, 0.8)
  }
  if (weightSum === 0) return { score: 0, hits, evidence }
  return { score: (score / weightSum) * gate, hits, evidence }
}

/** 把事件给的部分维度补全、归一化 */
export function normalizeDims(input = {}, context = {}) {
  const traits = context.traits ?? {}
  const energy = Number.isFinite(input.energy) ? input.energy : (context.energy ?? 0.5)
  const agency = input.agency ?? 'none'
  const intimacy = clamp01(input.intimacy ?? context.intimacy ?? 0.2)
  const norm = clamp01(input.norm ?? 0)
  const selfEsteem = clamp01((traits.selfEsteem ?? 55) / 100)
  const dims = {
    valence: clamp(Number(input.valence ?? 0), -1, 1),
    arousal: clamp01(input.arousal ?? 0.45),
    relevance: clamp01(input.relevance ?? 0.5),
    agency,
    selfAgency: agency === 'self' ? 1 : 0,
    // 应付能力:自尊高、精力足、有理由反击(对方越界)时更高;对方越亲、越没法翻脸,越低
    coping: clamp01(input.coping ?? (0.55 + (selfEsteem - 0.55) * 0.5 + (energy - 0.5) * 0.4 + (norm >= 0.5 ? 0.15 : 0) - intimacy * 0.3)),
    norm,
    // 公平默认是「谈不上」:只有事件明说了不公平(被质疑、被比较)才算数,
    // 否则任何越界都会被读成「不服」
    fairness: clamp(Number(input.fairness ?? 0), -1, 1),
    expectation: clamp(Number(input.expectation ?? 0), -1, 1),
    novelty: clamp01(input.novelty ?? 0.3),
    certainty: clamp01(input.certainty ?? 0.7),
    intimacy,
    recognition: clamp01(input.recognition ?? 0),
    spotlight: clamp01(input.spotlight ?? 0),
    benefit: clamp01(input.benefit ?? 0),
    resolution: clamp01(input.resolution ?? 0),
    rivalry: clamp01(input.rivalry ?? 0),
    attention: clamp01(input.attention ?? (input.relevance ?? 0.5)),
    compassion: clamp01(input.compassion ?? 0),
    play: clamp01(input.play ?? 0),
    social: clamp01(input.social ?? 0),
    desire: clamp01(input.desire ?? context.desire ?? 0),
    hunger: clamp01(input.hunger ?? context.hunger ?? 0),
    energy: clamp01(energy),
    load: clamp01(input.load ?? context.load ?? 0),
    selfEsteem,
  }
  // 对方在难受 → 默认带上共情通道(除非事件明说了别的)
  if (input.compassion === undefined && (input.otherDistress ?? 0) > 0.4) dims.compassion = clamp01(input.otherDistress)
  return dims
}

/** 按情绪家族微调:不同家族对人格特质的敏感度不一样 */
function traitModulator(emo, traits) {
  const neuro = (traits.neuroticism ?? 60) / 100
  const extra = (traits.extraversion ?? 58) / 100
  const open = (traits.openness ?? 62) / 100
  const agree = (traits.agreeableness ?? 52) / 100
  switch (emo.family) {
    case 'joy':
    case 'anticipation':
      return 0.8 + extra * 0.35 + open * 0.2
    case 'sadness':
    case 'fear':
      return 0.75 + neuro * 0.45
    case 'anger':
      return 0.8 + neuro * 0.3 + (1 - agree) * 0.35
    case 'social':
      return 0.8 + neuro * 0.35
    case 'trust':
      return 0.85 + agree * 0.3
    case 'disgust':
      return 0.85 + (1 - agree) * 0.3
    case 'drive':
      return 1
    default:
      return 1
  }
}

/**
 * 主入口:评价 → 情绪。
 * event: { kind, why, strength, dims, who, source }
 * context: { traits, energy, hunger, load, emotion, mood }
 * 返回:{ key, emotion, intensity, why, dims, score, runnerUp }
 */
export function appraise(event = {}, context = {}) {
  // 亲密度账本里是 0-100,评价里用 0-1
  const closeness = Number(event.who?.closeness)
  const intimacy = Number.isFinite(closeness) ? clamp01(closeness / 100) : undefined
  const dims = normalizeDims(event.dims ?? {}, {
    traits: context.traits,
    energy: context.energy,
    hunger: context.hunger,
    desire: context.desire,
    load: context.load,
    intimacy,
  })
  if (intimacy !== undefined) dims.intimacy = intimacy
  if (event.attention !== undefined) dims.attention = clamp01(event.attention)

  const ranked = []
  // 事件明说了哪些维度:没说且中性值也在区间里的约束,不算信息(见 scoreEmotion)
  const given = new Set(Object.keys(event.dims ?? {}))
  if (event.attention !== undefined) given.add('attention')
  for (const emo of EMOTIONS) {
    if (emo.key === 'calm') continue
    const { score, hits, evidence } = scoreEmotion(emo, dims, given)
    if (hits === 0) continue
    // 情绪得有「事件上的证据」才能起来;只有内部状态(精力/饿/累)不算 ——
    // 例外是困/饿这种生理驱动,它们本来就只由身体状态决定
    if (evidence === 0 && emo.family !== 'drive') continue
    ranked.push({ emo, score, hits })
  }
  // 分数接近时,「约束更多而且都符合」的那个更贴切(平局用命中数破);
  // 还是平局就看 priority —— 欲望家族带 2,这样「想要」不会被「感激」压掉
  ranked.sort((a, b) => (b.score - a.score) || (b.hits - a.hits) || ((b.emo.priority ?? 0) - (a.emo.priority ?? 0)))
  const best = ranked[0]
  const runnerUp = ranked[1]

  // 谁都对不上 → 平静(不产生冲量)
  if (!best || best.score < 0.42) {
    return { key: 'calm', emotion: emotionOf('calm'), intensity: 0, why: '', dims, score: best?.score ?? 0, runnerUp: null }
  }

  const strength = clamp01(event.strength ?? 0.5)
  const fit = clamp01(best.score)
  const raw = 100 * strength * (0.5 + 0.5 * fit)
  const intensity = Math.round(clamp(raw * traitModulator(best.emo, context.traits ?? {}), 0, 100))
  if (intensity < 8) {
    return { key: 'calm', emotion: emotionOf('calm'), intensity: 0, why: '', dims, score: best.score, runnerUp: null }
  }
  return {
    key: best.emo.key,
    emotion: best.emo,
    intensity,
    why: String(event.why ?? event.text ?? '').slice(0, 40),
    dims,
    score: best.score,
    runnerUp: runnerUp ? { key: runnerUp.emo.key, score: runnerUp.score } : null,
  }
}

/** 给调试/自测看:这个评价组合下排前几的是谁 */
export function rankEmotions(dimsInput, context = {}) {
  const dims = normalizeDims(dimsInput, context)
  const given = new Set(Object.keys(dimsInput ?? {}))
  return EMOTIONS.filter((emo) => emo.key !== 'calm')
    .map((emo) => ({ key: emo.key, name: emo.name, score: scoreEmotion(emo, dims, given).score }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
}

export { tierOf }
