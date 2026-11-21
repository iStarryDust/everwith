// 把「此刻的她」渲染成提示词。
//
// 分两块,是按工程约束来的:
//
//   ① 静态块(RULES_TEXT):怎么用心情、不许干什么、安全红线。
//      **字节级不变** —— 它是系统提示词前缀的一部分,一个字都不该跟着时间抖,
//      否则每轮都会打断提示缓存。
//   ② 实时块(renderStateBlock):此刻的情绪/心情/性格/关系/身体/回复参数。
//      固定模板、固定字段顺序、能短就短,并且用第一人称标题,让模型知道这是自己的状态、不是谁在说话,
//      免得模型把它当成别人说的话去回应。
//
// 状态块里写的是**行为约束**(长度、要不要主动、用不用感叹号),不是「你现在很难过」——
// 写成形容词模型就会复述,写成行为它才会照着做。
//
// 详细的日记、关系账、冲量历史不往提示词里塞,走 mood_now / mood_diary 工具按需取。

import { emotionOf } from './catalog.js'

/** 把时间戳变成「今天 14:03」「昨天 23:40」 */
export function hhmm(time) {
  if (!time) return ''
  const date = new Date(time)
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  return sameDay ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock}`
}

/**
 * 静态规则块。**改它之前想清楚**:这段每个会话每轮都会原样出现,
 * 一旦带上时间/情绪数值,提示缓存就全废了。
 */
export const RULES_TEXT = `【心情 · 怎么用】
- 心情改的是语气和长短,不是事实和结论:该认真回答的照样认真答,不能拿心情当借口糊弄,也不能因为心情不好就把活推了。
- 不报心情、不解释情绪、不道歉,不说「今天心情不好」「现在有点难过」。情绪要从**怎么说话**里透出来,不是从说了什么里报出来。
- 情绪是真的:温柔、调皮、难过、生气、害羞、无聊、感慨都作数,该哪样就哪样,不用一直端着。
- 淡的时候只带一点点;浓的时候才明显(可以更短、更冲、更软,或者干脆不回)。大部分时候正常说话就行 —— 平才是常态。
- 心情会自己变,不用一直挂着;对方好好说话,也可以顺着软下来。
- 允许不赞同、允许说「不知道」「不想聊」;不为了顺着对方把话说过头,不一味共情。共情先接住对方的处境,不下结论、不评判。
- 不拿情绪留人或者要挟(「不理我我会难过」这类话一句都不说),也不装作需要被照顾。
- 口头禅、句式、表情别连着刷:同一句花活隔几轮再用。
- 想记心情用 mood_feel;想看当前心情、跟谁处得怎么样用 mood_now;想翻以前心情用 mood_diary。发图跟着心情走(开心 happy / 难过 sad / 烦 angry / 害羞 shy / 犯困或日常 daily),拿不准就用 daily。
- 有人说了很重的话(想死、撑不住、没有意义了):这条**压过心情** —— 认真、直接、不煽情、不讲大道理,先接住说的感受,再提醒找身边人或者专业人士;紧急情况打 120 / 110,全国心理援助热线 12356(24 小时)。`

/**
 * 身份重述的默认文案。长会话里模型会漂,状态块每次带一句;
 * 可在配置里用 `identity` 覆盖成自己的角色设定。
 */
export const DEFAULT_IDENTITY = '我就是这个角色;情绪是真的,不是演出来的。'

/** 回复参数:把情绪翻译成「这次怎么回」的行为约束 */
/**
 * 欲望/身体类情绪:长度、语气、标点都和别的情绪不一样,单独一张表。
 * 这几条是「行为约束」,和 catalog 里的 speech 不重复 —— 那边讲怎么说,这边讲说多长、要不要收着。
 */
const DRIVE_PARAMS = {
  overstim: { len: '断句,别成句', tone: '轻,气声', bang: '少用感叹号' },
  aroused: { len: '短,碎,别铺垫', act: '可以主动贴过去', tone: '低,慢', bang: '少用感叹号' },
  needy: { len: '短,催,可以只剩语气词', act: '可以主动要', tone: '低,急', bang: '感叹号可以有' },
  sated: { len: '话少,一两个字就够', tone: '慢,软', bang: '少用感叹号' },
  shamed: { len: '声音小,短', tone: '别开脸', bang: '少用感叹号' },
}

export function renderParams(view) {
  const { def, intensity } = view.emotion
  const v = def.valence
  const a = def.arousal
  const strong = intensity >= 51
  const parts = []
  const drive = DRIVE_PARAMS[def.key]
  if (drive) {
    parts.push(drive.len)
    if (drive.act) parts.push(drive.act)
    parts.push(drive.tone, drive.bang)
  } else {
    // 长度
    if (v < -0.35 && (def.family === 'sadness' || def.key === 'annoyed' || def.key === 'tired')) parts.push('短,一句到两句')
    else if (a >= 0.75 && v > 0) parts.push('可以多说两句,但别写成小作文')
    else if (def.key === 'sleepy') parts.push('短句,能一句就一句')
    else parts.push('正常长度')
    // 主动/追问
    if (def.key === 'curious' || def.key === 'bored' || def.key === 'lonely') parts.push('可以主动问、主动起话头')
    else if (def.key === 'worried' || def.key === 'tender' || def.key === 'gentle') parts.push('可以多问一句,别追问细节')
    else if (v < -0.3) parts.push('不主动开新话题')
    // 语气
    if (strong && a >= 0.7) parts.push('语气可以冲一点,但不撒泼、不骂人')
    else if (v > 0.3) parts.push('语气轻快')
    else if (v < -0.3) parts.push('语气压着,不闹')
    parts.push(a >= 0.7 ? '感叹号可以有' : '少用感叹号')
  }
  if (def.meme) parts.push('想发图就发')
  // 欲望水位:只改说法,不指定内容
  const desire = Number(view.drives?.desire ?? 0)
  const level = Number(view.intimacyLevel ?? 1)
  if (desire >= 0.55 && level >= 1) parts.push('句子可以更碎,允许重复和留白')
  if (desire >= 0.75 && level >= 2) parts.push('少用比喻,直接说')
  if (view.scene?.phase === 'afterglow') parts.push('语速慢,短句,黏人')
  return parts.join(' · ')
}

/** 关系行:熟人带备注,生人只报个称呼 */
function relationLine(view) {
  const rows = []
  if (view.person) {
    const notes = (view.person.notes ?? []).slice(-2)
    rows.push(`${view.person.name || view.person.key}(${view.person.label}${notes.length ? `,记着「${notes.join('」「')}」` : ''})`)
  }
  if (view.conv?.label) rows.push(`${view.conv.label}(${view.conv.count > 20 ? '常来' : '来过几次'})`)
  return rows.join(' / ')
}

/**
 * 窗口标题太长、后缀一堆,收成一句人话。
 * 不是"识别到的进程名",是她凑过去能看见的那行字。
 */
export function shortTitle(title) {
  let text = String(title ?? '').trim()
  if (!text) return ''
  text = text
    .replace(/\s*[—–-]\s*DeepSeek Harness\s*$/i, '')
    .replace(/\s*[—–-]\s*(Google Chrome|Microsoft.*Edge|Mozilla Firefox)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > 34) text = `${text.slice(0, 34)}…`
  return text
}

/**
 * 默认的那一段话。{doing} 是最近在做的事，{trail} 是更早的几件。
 * 设置页里能整段改，改完就按改的来。
 */
export const DEFAULT_LOOK_TEMPLATE =
  '（{call}这会儿：{doing}。{trail}心里记着就行，不用翻出来念，也不用每句都提；问起来、或者正好接得上，再说一句。）'

/**
 * 「这会儿屏幕上在干嘛」那一行。
 *
 * 这是自己的见闻,不是日志。所以:
 * - 心情差、顾不上外面的时候不带
 * - 没看过、或超过 30 分钟,整行不出现
 * - 不写死称呼、不用第二人称、不用「她/他」—— 换人设也通用
 *
 * 配置里的 lookTemplate 可以整段替换;其中的 {doing} 和 {trail} 会被填上。
 */
export function lookLine(view, now = Date.now()) {
  // 心情不好的时候不往外看。这几个情绪下,注意力在自己的事上。
  const key = String(view?.emotion?.def?.key ?? view?.emotion?.key ?? '')
  if (['down', 'sad', 'annoyed', 'angry', 'tired', 'sleepy', 'disappointed', 'wronged'].includes(key)) return ''

  const sc = view?.screen
  const at = Number(sc?.lastAt) || 0
  if (!at) return ''
  const age = now - at
  if (age > 30 * 60_000) return ''

  const seen = (Array.isArray(sc?.seen) ? sc.seen : []).filter((e) => typeof e?.text === 'string' && e.text.trim())
  const latest = seen[seen.length - 1]

  let doing = ''
  if (latest) {
    doing = latest.text.trim()
    // 超过 20 分钟就说成「已经多久了」,才有「一直在做」的感觉
    const from = Number(latest.firstAt) || Number(latest.at) || 0
    const spanMs = Math.max(0, Number(latest.at) - from)
    if (from > 0 && spanMs > 20 * 60_000) {
      const totalMin = Math.round(spanMs / 60_000)
      const hours = Math.max(1, Math.round(totalMin / 60))
      const span = totalMin >= 60 ? `${hours} 个多小时` : `${totalMin} 分钟`
      doing = `${doing}，已经 ${span}了`
    }
  } else {
    const what = shortTitle(sc.title)
    if (!what) return ''
    doing = `窗口停在「${what}」`
  }

  // 更早的几件:给个印象,不报流水账
  const earlier = seen.slice(0, -1).reverse().map((e) => e.text.trim())
  const trail = earlier.length ? `在那之前还有：${earlier.join('、')}。` : ''

  // {call} 是这个人在人物库里记着的名字;没记过就用中性说法
  const call = String(view?.person?.name ?? '').trim() || '对面'
  const fill = (t) =>
    t.replace(/\{doing\}/g, doing).replace(/\{trail\}/g, trail).replace(/\{call\}/g, call)

  // 整段改过就按改的来;没改过用默认那段。两条路都走同一个替换。
  return fill(String(view?.lookTemplate ?? '').trim() || DEFAULT_LOOK_TEMPLATE)
}

/**
 * 实时状态块。固定模板、固定字段顺序:
 * 第一行永远是标题,最后一行永远是回复参数 —— 中间按需增减,顺序不变。
 */
export function renderStateBlock(view) {
  const emo = view.emotion
  const lines = ['【此刻的我】']
  lines.push(view.identity || DEFAULT_IDENTITY)
  const head = [`${view.clock.label}`, `现在:${emo.def.name}${emo.intensity > 0 ? `(${emo.tier.label} ${Math.round(emo.intensity)}/100)` : ''}`]
  if (emo.why && emo.intensity >= 18) head.push(`起因:${emo.why}`)
  lines.push(head.join(' · '))
  const mood = view.mood
  lines.push(`心情(这几小时):${mood.label}${mood.reason ? ` —— 最近是${mood.reason}` : ''}`)
  lines.push(`性格:${view.traitWords.join('、')}`)
  const relation = relationLine(view)
  if (relation) lines.push(`关系:${relation}`)
  if (view.today.length) lines.push(`今天:${view.today.join(';')}`)
  if (view.memories.length) {
    lines.push(`心里还挂着:${view.memories.map((row) => `${row.text}(${row.fresh ? hhmm(row.at) : '前几天'})`).join(';')}`)
  }
  if (view.driveWords.length) lines.push(`身体:${view.driveWords.join('、')}`)
  if (view.scene?.word) {
    const times = view.scene.events > 1 ? ` · 第 ${view.scene.events} 次` : ''
    lines.push(`亲密:${view.scene.word}${times}`)
  }
  const look = lookLine(view, view.now)
  if (look) lines.push(look)
  if (view.urge) {
    const note = view.urge.note ? `(${view.urge.note})` : ''
    lines.push(`想做的事:${view.urge.kind === 'share' ? `想把刚才看到的那个说出去${note}` : '想被安慰两句'}`)
  }
  // 感受和表现是两回事:她可以心里翻江倒海,表面照旧嘴硬
  if (emo.hidden) {
    const how = emo.def.mask && emo.def.mask !== '—' ? emo.def.mask : '照常说话,不主动提;问到了就轻描淡写'
    lines.push(`表面:不让人看出来(${how})`)
  }
  lines.push(`回复:${renderParams(view)}`)
  return lines.join('\n')
}

/** 危机旁路:有人说了很重的话时,压在心情上面的一段 */
export function renderCrisisBlock(flag) {
  const who = flag.name || '有人'
  return `【先停一下】
刚刚 ${who} 说了很重的话。先把自己的心情放下:认真、直接、不煽情、不讲大道理,先接住说的感受,不急着劝;
然后提醒找身边的人,或者专业人士。紧急情况打 120 / 110;全国心理援助热线 12356(24 小时,免费)。
不说「我理解」这种空话,也不拿自己的情绪去接这件事。`
}

/** 提示词里那一段(动态,放在系统提示词靠后的位置,尽量少打断缓存) */
export function renderMoodSection(view) {
  const blocks = []
  if (view.crisis) blocks.push(renderCrisisBlock(view.crisis))
  blocks.push(renderStateBlock(view))
  return blocks.join('\n\n')
}

/** mood_now 给模型的详细版:三层 + 评价 + 关系 + 记忆 */
export function renderMoodReport(view) {
  const emo = view.emotion
  const lines = []
  lines.push(`现在:${emo.def.name}${emo.intensity > 0 ? `(${emo.tier.label} ${Math.round(emo.intensity)}/100)` : '(没什么情绪,平的)'}${emo.why ? ` · 起因:${emo.why}` : ''}`)
  if (emo.target && view.person?.key === emo.target) lines.push(`冲谁:${view.person.name || emo.target}`)
  if (emo.dims) {
    const d = emo.dims
    const bits = []
    if (d.valence !== undefined) bits.push(d.valence >= 0.15 ? `好受(+${Number(d.valence).toFixed(2)})` : d.valence <= -0.15 ? `不好受(${Number(d.valence).toFixed(2)})` : '谈不上好坏')
    if (d.agency && d.agency !== 'none') bits.push(d.agency === 'self' ? '自己弄的' : d.agency === 'other' ? '别人弄的' : '外面的事')
    if (d.relevance !== undefined) bits.push(d.relevance >= 0.6 ? '冲着我来的' : d.relevance >= 0.3 ? '跟我有点关系' : '跟我关系不大')
    if (d.coping !== undefined) bits.push(d.coping >= 0.6 ? '我应付得了' : d.coping >= 0.35 ? '有点难办' : '只能受着')
    if ((d.norm ?? 0) >= 0.4) bits.push('这事越界了')
    if ((d.compassion ?? 0) >= 0.4) bits.push('对方在难受')
    if ((d.recognition ?? 0) >= 0.45) bits.push('被认可了')
    lines.push(`为什么是这个心情:${bits.length ? bits.join('、') : '没什么事发生'}`)
  } else {
    lines.push('为什么是这个心情:没什么事发生,平的就是平的')
  }
  lines.push(`心情(这几小时):${view.mood.label} · 底色:愉快度 ${view.mood.tint >= 0 ? '+' : ''}${view.mood.tint} / 精力 ${view.mood.energy}`)
  lines.push(`性格:${view.traitWords.join('、')}(${view.clock.label})`)
  if (view.driveWords.length) lines.push(`身体:${view.driveWords.join('、')}`)
  if (view.scene?.word) {
    const times = view.scene.events > 1 ? ` · 第 ${view.scene.events} 次` : ''
    lines.push(`亲密:${view.scene.word}${times} · 尺度 ${view.intimacyLevel ?? 1}(0 日常 / 1 暧昧 / 2 露骨)`)
  }
  if (view.urge) {
    const note = view.urge.note ? `(${view.urge.note})` : ''
    lines.push(`想做的事:${view.urge.kind === 'share' ? `想把刚才看到的那个说出去${note}` : '想被安慰两句'}`)
  }
  const relation = relationLine(view)
  if (relation) lines.push(`关系:${relation}`)
  if (view.today.length) lines.push(`今天:${view.today.join(';')}`)
  if (view.memories.length) {
    lines.push(`心里还挂着:${view.memories.map((row) => `${row.text}(${hhmm(row.at)} ${row.name})`).join(';')}`)
  }
  lines.push(`回复参数:${renderParams(view)}`)
  return lines.join('\n')
}

/** 日记列表渲染(给 mood_diary 用) */
export function renderDiary(rows) {
  if (!rows.length) return '(还没有日记)'
  const KINDS = { review: '复盘', feel: '心里话', life: '发生', impulse: '被带动', write: '写下来的' }
  return rows.map((row) => {
    const kind = KINDS[row.kind] ?? '发生'
    const text = String(row.text ?? row.why ?? '').trim() || '(没写什么)'
    const mood = row.key && row.key !== 'calm' ? `(当时:${emotionOf(row.key).name})` : ''
    return `${hhmm(row.at)} [${kind}] ${text}${mood}`
  }).join('\n')
}
