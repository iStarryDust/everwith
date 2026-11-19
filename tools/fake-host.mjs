// 假宿主自测:不装插件、不重启 DSH,直接给 apply() 一个最小 ctx,
// 把两块提示词、三个工具、评价引擎、状态机、动力学全跑一遍。
//
// 用法: node tools/fake-host.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, mergeConfig, DEFAULTS, PLUGIN_REV } from '../plugin.js'
import { emotionOf, EMOTIONS, TRAITS, tierOf } from '../lib/catalog.js'
import { appraise } from '../lib/appraise.js'
import {
  applyImpulse, catharsis, circadian, decay, dueRumination, emptyState, halfLifeOf, loadState, maybeLifeEvent, migrate,
  moodLabel, nightlyReview, soothe, traitWords, warmthLabel,
} from '../lib/state.js'

let failed = 0
let passed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`)
  if (ok) passed++
  else failed++
}
const has = (text, needle) => String(text).includes(needle)

/** 起一个假宿主:同一份代码,独立的账本目录 */
function bootHost({ config = {} } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'everwith-state-'))
  const registered = new Map()
  const sections = []
  const effects = []
  const logs = []
  const fakeTools = {
    register(def) {
      if (registered.has(def.name)) throw new Error(`duplicate tool ${def.name}`)
      registered.set(def.name, def)
    },
    get(name) {
      return name === 'qqbot_send_file' ? { name } : undefined
    },
  }
  const makeScope = () => ({
    get: (name) => (name === 'tools' ? fakeTools : undefined),
    effect: (fn) => { const disposer = fn(); effects.push(typeof disposer === 'function' ? disposer : () => {}) },
    systemPrompt: { section: (row) => { sections.push(row); return () => {} } },
  })
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    get: (name) => (name === 'tools' ? fakeTools : undefined),
    inject: (_deps, callback) => callback(makeScope()),
    effect: (fn) => { const disposer = fn(); effects.push(typeof disposer === 'function' ? disposer : () => {}) },
  }
  apply(ctx, { stateDir, ...config })
  const renderWith = (name, session) => {
    const row = sections.find((item) => item.name === name)
    const fn = row?.text
    return typeof fn === 'function' ? fn({ agent: { session } }) : String(fn ?? '')
  }
  /** 宿主组装提示词时两块都会调,这里按 order 排好拼起来 */
  const render = (session) => [...sections]
    .sort((a, b) => a.order - b.order)
    .map((row) => renderWith(row.name, session))
    .filter(Boolean)
    .join('\n\n')
  const run = async (name, args, session) => {
    const def = registered.get(name)
    if (!def) throw new Error(`no tool ${name}`)
    const value = await def.execute(args, { agent: { session } })
    // 契约:render 必须返回 ContentBlock[](dsh-tools 的 ToolOutput.render 签名)
    const blocks = def.output.render(args, value)
    if (!Array.isArray(blocks)) throw new Error(`${name}.output.render 没有返回数组`)
    return blocks.map((block) => block.text).join('\n')
  }
  // 账本还没落盘时也读得出来(空账本),测试不用到处判空
  const readState = () => {
    try { return JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')) } catch { return loadState(stateDir) }
  }
  const writeState = (row) => writeFileSync(join(stateDir, 'state.json'), JSON.stringify(row))
  return { stateDir, registered, sections, effects, logs, render, renderWith, run, readState, writeState }
}

/** 会话:可往里面塞新消息,seq 自己涨。事件形状照抄真实会话日志(data.content 是数组) */
function makeSession(id, { rpcId = false, group = true, who = '星星', uid = 'u-1' } = {}) {
  const events = []
  const pushEvent = (text, at, shape) => {
    events.push({
      type: 'user/message',
      seq: events.length + 1,
      time: at,
      data: {
        role: 'user',
        id: `m-${id}-${events.length + 1}`,
        source: { kind: 'user', ...(rpcId ? { rpcId: `rpc-${id}` } : {}) },
        ...(shape === 'alt'
          ? { message: { content: [{ type: 'text', text: group ? `[${who} (${uid})] ${text}` : text }] } }
          : { content: [{ type: 'text', text: group ? `[${who} (${uid})] ${text}` : text }] }),
      },
    })
  }
  const session = {
    id,
    push(text, at = Date.now()) { pushEvent(text, at); return session },
    pushAltShape(text, at = Date.now()) { pushEvent(text, at, 'alt'); return session },
    snapshotEvents: () => events.slice(),
  }
  return session
}

const baseContext = (over = {}) => ({ traits: { ...emptyState().traits, ...over }, energy: 0.5, hunger: 0, load: 0 })

// ══════════════════════════════════════════════════════════════════════════
console.log(`== 注册与契约 (rev ${PLUGIN_REV}) ==`)
{
  const host = bootHost()
  for (const name of ['mood_now', 'mood_feel', 'mood_diary']) {
    const def = host.registered.get(name)
    check(`工具 ${name} 已注册`, Boolean(def), def ? `参数: ${Object.keys(def.parameters.properties).join(',')}` : '')
    if (!def) continue
    check(`  ${name}.output.render 返回 ContentBlock[]`, Array.isArray(def.output.render({}, { text: 'x' })))
    check(`  ${name} schema 是 object`, def.parameters.type === 'object')
    const required = def.parameters.required ?? []
    check(`  ${name} 的 required 都在 properties 里`, required.every((key) => key in def.parameters.properties))
  }
  const rules = host.sections.find((row) => row.name === 'everwith:rules')
  const now = host.sections.find((row) => row.name === 'everwith:now')
  check('静态规则段已注册(order 100)', Boolean(rules) && rules.order === 100, `order=${rules?.order}`)
  check('实时状态段已注册(order 9800,放在提示词最后)', Boolean(now) && now.order === 9800, `order=${now?.order}`)
  check('两段文本都是函数(每次组装按此刻渲染)', typeof rules?.text === 'function' && typeof now?.text === 'function')
  check('心跳定时器已登记且可清理', host.effects.length >= 1)
  for (const dispose of host.effects) { try { dispose() } catch { /* disposer */ } }
  rmSync(host.stateDir, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== 提示词:静态规则字节级不变 + 实时块固定模板 ==')
{
  const host = bootHost()
  const session = makeSession('sess-qq').push('在吗')
  const first = host.renderWith('everwith:rules', session)
  const second = host.renderWith('everwith:rules', session)
  check('规则段两次渲染完全一样(提示缓存友好)', first === second && first.length > 200, `${first.length} 字`)
  check('规则段带「别报心情」', has(first, '别报心情'))
  check('规则段带「不能用情绪留人」', has(first, '不能拿自己的情绪留人'))
  check('规则段带「允许不赞同」(反谄媚)', has(first, '允许不赞同'))
  check('规则段带口癖预算', has(first, '口头禅、句式、表情别连着刷'))
  check('规则段带危机指引(12356)', has(first, '12356'))
  check('规则段不带时间/数值(缓存友好)', !/\d{1,2}:\d{2}/.test(first) && !has(first, '/100'))

  const live = host.renderWith('everwith:now', session)
  check('实时块标注「系统生成」', has(live, '系统生成的状态'))
  check('实时块重述身份(抗漂移)', has(live, '你是这个角色本人'))
  check('实时块有现在/心情/性格/回复', ['现在:', '心情(这几小时):', '性格:', '回复:'].every((key) => has(live, key)))
  check('实时块写的是行为约束而不是情绪形容词', has(live, '回复:') && !has(live, '你现在很难过'))
  check('实时块足够短(不挤占注意力)', live.split('\n').length <= 12, `${live.split('\n').length} 行`)
  const web = makeSession('sess-web', { rpcId: true }).push('在吗')
  check('Web 会话默认也注入', has(host.render(web), '【心情 · 实时】'))
  const off = bootHost({ config: { channels: { web: false } } })
  check('channels.web=false 时 Web 不注入', off.renderWith('everwith:now', web) === '')
  const muted = bootHost({ config: { promptEnabled: false } })
  check('promptEnabled=false 时两块都不注入', muted.renderWith('everwith:now', session) === '' && muted.renderWith('everwith:rules', session) === '')
  for (const h of [host, off, muted]) {
    for (const dispose of h.effects) { try { dispose() } catch { /* disposer */ } }
    rmSync(h.stateDir, { recursive: true, force: true })
  }
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== 评价引擎:同一句话,陌生人和熟人结果不一样 ==')
{
  const dims = { valence: -0.55, agency: 'other', norm: 0.6, relevance: 0.9, arousal: 0.65 }
  const stranger = appraise({ kind: 'message', strength: 0.7, why: 'x叫她胖', dims, who: { closeness: 20 } }, baseContext())
  const close = appraise({ kind: 'message', strength: 0.7, why: 'x叫她胖', dims, who: { closeness: 85 } }, baseContext())
  check('被叫胖(陌生人)→ 生气', stranger.key === 'angry', stranger.key)
  check('被叫胖(熟人)→ 委屈(熟人的刀更疼)', close.key === 'wronged', close.key)
  const praise = appraise({ kind: 'message', strength: 0.6, dims: { valence: 0.75, agency: 'other', recognition: 0.9, relevance: 0.7, attention: 0.4 }, who: { closeness: 50 } }, baseContext())
  check('被夸能干 → 得意', praise.key === 'proud', praise.key)
  const cute = appraise({ kind: 'message', strength: 0.6, dims: { valence: 0.7, agency: 'other', attention: 0.95, spotlight: 0.9, recognition: 0.2, relevance: 0.8 }, who: { closeness: 50 } }, baseContext())
  check('被夸可爱 → 害羞', cute.key === 'shy', cute.key)
  const help = appraise({ kind: 'message', strength: 0.7, dims: { valence: -0.5, compassion: 0.85, otherDistress: 0.85, relevance: 0.7, certainty: 0.6 }, who: { closeness: 40 } }, baseContext())
  check('有人说难受 → 担心(不是难过)', help.key === 'worried', help.key)
  const unfair = appraise({ kind: 'message', strength: 0.55, dims: { valence: -0.4, agency: 'other', norm: 0.5, relevance: 0.8, fairness: -0.5 }, who: { closeness: 30 } }, baseContext())
  check('被质疑/被比较 → 不服', unfair.key === 'indignant', unfair.key)
  const unknown = appraise({ kind: 'message', strength: 0.5, dims: {}, who: { closeness: 30 } }, baseContext())
  check('什么维度都没有 → 不产生情绪', unknown.key === 'calm', unknown.key)
  const content = appraise({ kind: 'life', strength: 0.6, dims: { valence: 0.6, arousal: 0.3, relevance: 0.6 } }, baseContext())
  check('扒完一碗白饭 → 满足', content.key === 'content', content.key)
  const sleepy = appraise({ kind: 'life', strength: 0.5, dims: {} }, { ...baseContext(), energy: 0.1 })
  check('精力见底 → 困(靠内部状态推出来)', sleepy.key === 'sleepy', sleepy.key)
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== 动力学:惯性 / 习惯化 / 消极偏差 / 升级 ==')
{
  const state = emptyState()
  let now = Date.now()
  const first = applyImpulse(state, { key: 'annoyed', intensity: 45, why: '有人催她', source: 'message', stimulus: 'pushy' }, now)
  check('第一次被催 → 烦 45', first.key === 'annoyed' && first.intensity === 45, `${first.key}/${first.intensity}`)
  now += 60_000
  const suppressed = applyImpulse(state, { key: 'happy', intensity: 20, why: '有人夸她', source: 'message', stimulus: 'praise' }, now)
  check('正在烦的时候,小的开心顶不动(情绪惯性)', suppressed.suppressed === true, `${suppressed.key}/${suppressed.intensity}`)
  const repeated = []
  for (let i = 0; i < 4; i++) {
    now += 5 * 60_000
    repeated.push(applyImpulse(state, { key: 'annoyed', intensity: 45, why: '又催', source: 'message', stimulus: 'pushy' }, now))
  }
  check('同样的话反复说,效果递减(习惯化)', repeated[3].intensity < repeated[0].intensity, `${repeated[0].intensity} → ${repeated[3].intensity}`)
  check('同一个家族堆到 70 以上会升级(烦 → 生气)', state.emotion.key === 'angry', `${state.emotion.key}/${state.emotion.intensity}`)

  const bad = emptyState()
  applyImpulse(bad, { key: 'angry', intensity: 60, why: '被骂', source: 'message', stimulus: 'x' }, now)
  const good = emptyState()
  applyImpulse(good, { key: 'happy', intensity: 60, why: '被夸', source: 'message', stimulus: 'y' }, now)
  check('消极偏差:坏事的推力比好事大', Math.abs(bad.core.valence) > Math.abs(good.core.valence), `${bad.core.valence.toFixed(1)} vs ${good.core.valence.toFixed(1)}`)

  // 不对称切换:坏事顶掉好心情容易,好事翻不了坏心情
  const happyState = emptyState()
  applyImpulse(happyState, { key: 'happy', intensity: 60, why: '被夸', source: 'message', stimulus: 'a' }, now)
  const downPush = applyImpulse(happyState, { key: 'annoyed', intensity: 30, why: '被催', source: 'message', stimulus: 'b' }, now + 60_000)
  check('好心情容易被一句话毁掉(负向门槛低)', downPush && !downPush.suppressed, `${downPush?.key}/${downPush?.intensity}`)
  const angryState = emptyState()
  applyImpulse(angryState, { key: 'angry', intensity: 60, why: '被骂', source: 'message', stimulus: 'c' }, now)
  const upPush = applyImpulse(angryState, { key: 'happy', intensity: 30, why: '被夸', source: 'message', stimulus: 'd' }, now + 60_000)
  check('生气的时候小开心顶不动(正向门槛高)', upPush?.suppressed === true, `${upPush?.key}/${upPush?.intensity}`)

  // 单次底色推力有上限
  const capState = emptyState()
  const huge = applyImpulse(capState, { key: 'angry', intensity: 100, why: '被骂得很惨', source: 'message', stimulus: 'e' }, now)
  check('一句话最多把底色挪 22 分(底色是攒出来的)', Math.abs(huge.coreDelta) <= 22.01, huge.coreDelta.toFixed(1))
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== 衰减 / 半衰期 / 作息 / 心情标签 ==')
{
  const state = emptyState()
  const now = Date.now()
  applyImpulse(state, { key: 'happy', intensity: 80, why: '好事', source: 'message', stimulus: 'a' }, now)
  const halfLife = halfLifeOf(emotionOf('happy'), state.traits)
  decay(state, now + halfLife * 60_000)
  check(`半衰期到了,情绪掉一半(设计 ${Math.round(halfLife)} 分钟)`, Math.abs(state.emotion.intensity - 40) <= 6, `80 → ${state.emotion.intensity.toFixed(1)}`)
  decay(state, now + halfLife * 60_000 * 6)
  check('再久一点就淡没了,回到平静', state.emotion.key === 'calm', `${state.emotion.key}/${state.emotion.intensity.toFixed(1)}`)
  const night = circadian(new Date('2026-11-01T03:00:00'))
  const noon = circadian(new Date('2026-11-01T12:00:00'))
  check('后半夜精力基线低于中午', night.energy < noon.energy, `${night.label} ${night.energy} vs ${noon.label} ${noon.energy}`)
  const mood = moodLabel(state, now + halfLife * 60_000 * 6)
  check('心情标签是弥散的说法,不是情绪名', ['挺顺的', '还不错', '一般', '有点闷', '挺沉的', '蔫蔫的'].includes(mood.label), mood.label)
  const words = traitWords(state.traits)
  check('性格用词说出来(不是报分数)', words.length > 0 && words.every((word) => word.length <= 6), words.join('、'))

  // 双指数:先快后慢,难过留得比开心久
  const longSad = emptyState()
  applyImpulse(longSad, { key: 'sad', intensity: 70, why: '难受', source: 'message', stimulus: 's1' }, now)
  const shortHappy = emptyState()
  applyImpulse(shortHappy, { key: 'happy', intensity: 70, why: '开心', source: 'message', stimulus: 'h1' }, now)
  decay(longSad, now + 3 * 3_600_000)
  decay(shortHappy, now + 3 * 3_600_000)
  check('三小时后:难过还在,开心基本没了(难过留得久)', longSad.emotion.intensity > shortHappy.emotion.intensity + 8,
    `难过 ${longSad.emotion.intensity.toFixed(0)} vs 开心 ${shortHappy.emotion.intensity.toFixed(0)}`)
  const tail = emptyState()
  applyImpulse(tail, { key: 'sad', intensity: 70, why: '难受', source: 'message', stimulus: 's2' }, now)
  const sadHl = halfLifeOf(emotionOf('sad'), tail.traits, 70)
  decay(tail, now + 4 * sadHl * 60_000)
  const tailRemaining = tail.emotion.key === 'sad' ? tail.emotion.intensity / 70 : 0
  const pureRemaining = Math.pow(0.5, 4)
  check('四个半衰期之后还留着一截(长尾,纯指数早就没了)', tailRemaining > pureRemaining * 1.25,
    `残留 ${(tailRemaining * 100).toFixed(1)}% vs 纯指数 ${(pureRemaining * 100).toFixed(1)}%`)
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== 反刍 / 宣泄 / 被哄 / 记忆点 ==')
{
  const now = Date.now()
  let scheduled = 0
  for (let i = 0; i < 60 && !scheduled; i++) {
    const state = emptyState()
    applyImpulse(state, { key: 'wronged', intensity: 70, why: '被说了一嘴', source: 'message', stimulus: 'x' }, now)
    decay(state, now + 6 * 3_600_000)
    scheduled = state.rumination.length
  }
  check('没消化掉的委屈会排进反刍队列', scheduled > 0, `${scheduled} 条`)

  // 续命:强情绪淡到一半时会自己翻上来,最多三次
  const revive = emptyState()
  applyImpulse(revive, { key: 'wronged', intensity: 80, why: '被说了一嘴', source: 'message', stimulus: 'r1' }, now)
  let revived = 0
  for (let i = 0; i < 8 && !revived; i++) {
    decay(revive, now + (i + 1) * 20 * 60_000)
    revived = revive.rumination.filter((row) => row.revive).length
  }
  check('强情绪淡到一半会「续命」(越想越气)', revived > 0, `${revived} 条`)
  const reviveRow = revive.rumination.find((row) => row.revive)
  check('续命最多三次', (reviveRow?.left ?? 0) <= 3, String(reviveRow?.left))
  check('续命一次只回补一点(8% 峰值)', (reviveRow?.intensity ?? 99) <= 10, String(reviveRow?.intensity))
  const reviveImpulse = reviveRow ? dueRumination({ ...revive, rumination: [reviveRow] }, reviveRow.at + 1) : null
  check('续命会连着排下一次', Boolean(reviveImpulse?.revive))

  const state = emptyState()
  applyImpulse(state, { key: 'sad', intensity: 70, why: '难受', source: 'message', stimulus: 'y' }, now)
  check('记忆点:够强的情绪会留下痕迹', state.memories.length === 1 && state.memories[0].intensity >= 62)
  const released = catharsis(state, now, 1)
  check('写日记能宣泄(情绪真的降下来)', released > 0, `放下 ${released} 分`)

  const soothed = emptyState()
  applyImpulse(soothed, { key: 'angry', intensity: 80, why: '被骂', source: 'message', stimulus: 'z' }, now)
  const before = soothed.emotion.intensity
  const out = soothe(soothed, { person: 'u-1', why: '道歉', strength: 1, now })
  check('被哄/被道歉:气消一半以上', out.soothed && soothed.emotion.intensity < before * 0.6, `${before} → ${Math.round(soothed.emotion.intensity)}`)
  check('被哄之后关系回暖', (soothed.people['u-1']?.warmth ?? 0) > 0)
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== 会话反应:走完整链路(消息 → 评价 → 情绪 → 账本) ==')
{
  const host = bootHost()
  const session = makeSession('sess-1')
  session.push('星星:你好胖啊')
  const text = host.render(session)
  check('被叫胖之后实时块写上了情绪', has(text, '生气') || has(text, '委屈'), text.split('\n')[3] ?? '')
  check('起因写进去了', has(text, '叫她胖'))
  const state = host.readState()
  check('游标落盘(重启不会重复读旧消息)', Number(state.seen['sess-1']) >= 1, `seq=${state.seen['sess-1']}`)
  check('关系账记了这个人', Boolean(state.people['u-1']))
  check('这个人被记了一笔「叫她胖」', (state.people['u-1'].notes ?? []).some((note) => note.includes('胖')))
  check('暖度是负的', state.people['u-1'].warmth < 0, String(state.people['u-1'].warmth))
  check('日记里有这一笔', state.diary.some((row) => row.kind === 'impulse' && row.text.includes('胖')))
  check('审计日志写了', readFileSync(join(host.stateDir, 'audit.jsonl'), 'utf8').includes('"kind":"react"'))
  check('加载痕迹写了(能确认跑的是哪一版)', readFileSync(join(host.stateDir, 'load.log'), 'utf8').includes(PLUGIN_REV))

  const host2 = bootHost()
  const old = makeSession('sess-old')
  old.push('星星:你好胖啊', Date.now() - 3 * 3_600_000)
  host2.render(old)
  check('三小时前的消息不翻旧账(心情不变)', host2.readState().emotion.key === 'calm', host2.readState().emotion.key)

  const host3 = bootHost()
  const quiet = makeSession('sess-3')
  quiet.push('星星:好无聊啊')
  host3.render(quiet)
  const quietIntensity = host3.readState().emotion.intensity
  const host4 = bootHost()
  const loud = makeSession('sess-4')
  loud.push('星星:好无聊啊 (@you)')
  host4.render(loud)
  const loudIntensity = host4.readState().emotion.intensity
  check('群里没点名时冲量打折', quietIntensity < loudIntensity, `${quietIntensity} vs ${loudIntensity}`)

  const host5 = bootHost()
  const chatty = makeSession('sess-5')
  chatty.push('星星:快点啊')
  host5.render(chatty)
  const firstPush = host5.readState().emotion.intensity
  chatty.push('星星:快点啊')
  host5.render(chatty)
  check('四分钟内的第二次催不重复上头(冷却)', host5.readState().emotion.intensity <= firstPush, `${firstPush} → ${host5.readState().emotion.intensity}`)

  const host6 = bootHost()
  const crisis = makeSession('sess-6')
  crisis.push('星星:我最近真的撑不住了,不想活了')
  const crisisText = host6.render(crisis)
  check('危机信号会插一段「压过心情」的指引', has(crisisText, '【优先 · 有人在硬撑】'))
  check('危机指引里有求助渠道', has(crisisText, '12356') && has(crisisText, '120'))
  check('危机时情绪引擎让位(明说和心情无关)', has(crisisText, '这条压过心情'))
  check('危机标记落盘了', Boolean(host6.readState().flags?.crisis))

  // 表现层:不熟的人面前,「担心」这种情绪先憋着(生气藏不住,那就不装)
  const host7 = bootHost()
  const stranger = makeSession('sess-7', { uid: 'u-stranger', who: '路人' })
  stranger.push('路人:我最近真的撑不住了,有点扛不住')
  const strangerText = host7.render(stranger)
  check('不熟的人面前会掩饰(表面:不让人看出来)', has(strangerText, '表面:') && has(strangerText, '不让人看出来'),
    strangerText.split('\n').find((line) => line.startsWith('现在:')) ?? '')
  const host7b = bootHost()
  const strangerAngry = makeSession('sess-7b', { uid: 'u-stranger2', who: '路人' })
  strangerAngry.push('路人:你好胖啊')
  const angryText = host7b.render(strangerAngry)
  check('藏不住的情绪不硬装(生气就写在脸上)', !has(angryText, '不让人看出来'))
  const host8 = bootHost()
  const close = makeSession('sess-8', { uid: 'u-close', who: '星星' })
  for (let i = 0; i < 12; i++) close.push(`星星:谢谢你,今天也辛苦了${i}`)
  host8.render(close)
  close.push('星星:你今天有点烦人')
  const closeText = host8.render(close)
  check('熟人面前不装(情绪直接写在脸上)', !has(closeText, '不让人看出来'))
  for (const h of [host, host2, host3, host4, host5, host6, host7, host7b, host8]) {
    for (const dispose of h.effects) { try { dispose() } catch { /* disposer */ } }
    rmSync(h.stateDir, { recursive: true, force: true })
  }
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== 工具:mood_now / mood_feel(申请语义) / mood_diary ==')
{
  const host = bootHost()
  const session = makeSession('sess-tool').push('星星:在吗')
  // 先渲染一次,把「在吗」读掉,后面的心情才是她自己记的
  host.render(session)
  const nowText = await host.run('mood_now', {}, session)
  check('mood_now 报三层', ['现在:', '心情(这几小时):', '性格:', '回复参数:'].every((key) => has(nowText, key)))
  check('mood_now 解释「为什么是这个心情」', has(nowText, '为什么是这个心情') || has(nowText, '起因'))
  const diag = await host.run('mood_now', { action: 'diag' }, session)
  check('mood_now diag 报版本和渠道', has(diag, PLUGIN_REV) && has(diag, '渠道 qq'))
  check('diag 报驱动和统计', has(diag, '驱动:') && has(diag, '统计:'))

  const feel = await host.run('mood_feel', { emotion: '委屈', intensity: 60, why: '被说了一句', person: '星星', warmth: -6, show: false }, session)
  check('mood_feel 认中文情绪名', has(feel, '委屈'), feel.split('\n')[0])
  check('mood_feel 回执里说清实际生效多少', has(feel, '/100'))
  check('mood_feel 支持「不让人看出来」', has(feel, '不让人看出来'))
  const live = host.render(session)
  check('「不让人看出来」会进实时块(表面:…)', has(live, '表面:'), live.split('\n').find((line) => line.startsWith('表面:')) ?? '')
  const bad = await host.run('mood_feel', { emotion: '???', intensity: 50 }, session)
  check('认不出的情绪会给出可用清单', has(bad, '认不出') && has(bad, 'angry'))
  const spam = []
  for (let i = 0; i < 8; i++) spam.push(await host.run('mood_feel', { emotion: '烦', intensity: 40, why: '刷' }, session))
  check('配额/冷却会挡住反复加码', spam.some((text) => has(text, '够多了') || has(text, '不重复加码')), spam.at(-1).split('\n')[0])
  const audit = readFileSync(join(host.stateDir, 'audit.jsonl'), 'utf8')
  check('每次记心情都进了审计日志', audit.includes('"kind":"feel"'))

  const write = await host.run('mood_diary', { action: 'write', text: '今天有点累,不过还行', mood: '低落' }, session)
  check('mood_diary write 能写心里话', has(write, '写下了'))
  const read = await host.run('mood_diary', { action: 'read', days: 1 }, session)
  check('mood_diary read 能翻到', has(read, '今天有点累'))
  const reflect = await host.run('mood_diary', { action: 'reflect' }, session)
  check('mood_diary reflect 能复盘', has(reflect, '复盘') || has(reflect, '没什么可复盘'))
  for (const dispose of host.effects) { try { dispose() } catch { /* disposer */ } }
  rmSync(host.stateDir, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== 生活 / 驱动 / 复盘 / 性格漂移 ==')
{
  const noon = new Date('2026-11-01T12:30:00').getTime()
  const life = emptyState()
  life.stats.lastLifeAt = 0
  let picked = null
  for (let i = 0; i < 60 && !picked; i++) picked = maybeLifeEvent(life, noon, { chance: 0.5, minGapMin: 0 })
  check('心跳能掷出自己的小事', Boolean(picked), picked?.text ?? '')
  check('小事有间隔限制(不会一分钟过一天)', maybeLifeEvent(life, noon + 60_000, { chance: 1, minGapMin: 45 }) === null)

  const hungry = emptyState()
  hungry.core.updatedAt = noon - 5 * 3_600_000
  hungry.drives.hunger = 0.1
  decay(hungry, noon)
  check('过了饭点没吃,饿意会涨', hungry.drives.hunger > 0.1, hungry.drives.hunger.toFixed(2))
  check('饿到一定程度会自己变成「饿」这个情绪', appraise({ kind: 'life', strength: 0.5, dims: {} }, { ...baseContext(), hunger: 0.9 }).key === 'hungry')

  const review = emptyState()
  applyImpulse(review, { key: 'happy', intensity: 60, why: '有人夸她', source: 'message', stimulus: 'a' }, noon - 2 * 3_600_000)
  const reviewed = nightlyReview(review, new Date('2026-11-01T23:10:00').getTime())
  check('深夜会复盘这一天(写进日记)', Boolean(reviewed) && has(reviewed.text, '今天'), reviewed?.text ?? '')
  check('复盘会说清来了哪些情绪', reviewed?.text?.includes('都来过') ?? false)
  check('复盘之后当天不会再复盘', nightlyReview(review, noon + 60_000) === null)

  const drift = emptyState()
  const base = { ...drift.traits }
  for (let i = 0; i < 20; i++) {
    applyImpulse(drift, { key: 'proud', intensity: 60, why: '被夸', source: 'message', stimulus: `p${i}` }, noon + i * 60_000)
  }
  check('被反复认可,自尊会慢慢涨(性格漂移)', drift.traits.selfEsteem > base.selfEsteem, `${base.selfEsteem} → ${drift.traits.selfEsteem.toFixed(2)}`)
  check('漂移有上限(不会变成另一个人)', Math.abs(drift.traits.selfEsteem - base.selfEsteem) <= 12)
  check('性格基线本身没被改掉', drift.traitBase.selfEsteem === base.selfEsteem)
  check('关系暖度能翻译成人话', ['自己人', '混得挺熟', '认识', '刚认识', '有点芥蒂', '不太想理'].includes(warmthLabel(60, 80)))
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== 老账本能升级(v1 → v2) ==')
{
  const legacy = {
    version: 1,
    mood: { key: 'proud', intensity: 44, why: '给自己写了套心情', source: 'self', startedAt: 1, updatedAt: Date.now() },
    core: { valence: 3, energy: 46, updatedAt: Date.now() },
    convs: { 'group:g1': { first: 1, lastAt: 2, count: 9, warmth: 5, label: '群 g1' } },
    people: { 'u-9': { name: '星星', warmth: 12, notes: ['夸她能干'], lastAt: 2, count: 3 } },
    diary: [{ at: 1, kind: 'feel', key: 'proud', text: '给自己写了套心情', intensity: 0 }],
    seen: { 'sess-x': 9 },
    stats: { impulses: 1, feels: 1 },
  }
  const migrated = migrate(legacy)
  check('v1 的情绪搬进 v2', migrated.emotion.key === 'proud' && migrated.emotion.intensity === 44, `${migrated.emotion.key}/${migrated.emotion.intensity}`)
  check('v1 的底色留着', migrated.core.valence === 3 && migrated.core.energy === 46)
  check('v1 的人关系换算成亲密度/信任', migrated.people['u-9'].closeness > 30 && migrated.people['u-9'].notes.includes('夸她能干'))
  check('v1 的日记留着', migrated.diary.length === 1)
  check('v1 的游标留着(不会重复读旧消息)', migrated.seen['sess-x'] === 9)
  check('升级后补上了 v2 的字段', Array.isArray(migrated.affect) && Boolean(migrated.drives) && Boolean(migrated.traits) && Boolean(migrated.flags))
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== 坏输入不连坐 ==')
{
  const host = bootHost()
  let ok = true
  const broken = { id: 'sess-broken', snapshotEvents() { throw new Error('boom') } }
  try { host.render(broken) } catch { ok = false }
  check('会话读不了时渲染不抛错(整份提示词不能挂)', ok)
  const brokenId = { get id() { throw new Error('boom') }, snapshotEvents: () => [] }
  ok = true
  try { host.renderWith('everwith:now', brokenId) } catch { ok = false }
  check('会话 id 读不了时也不抛', ok)
  const empty = makeSession('sess-empty')
  check('没有消息时不报错、也不产生情绪', has(host.render(empty), '【心情 · 实时】') && host.readState().emotion.key === 'calm')
  const weird = makeSession('sess-weird').pushAltShape('星星:谢谢你,辛苦了')
  const weirdText = host.render(weird)
  check('宿主另一版的消息形状(data.message.content)也认', has(weirdText, '感激') || has(weirdText, '开心'), host.readState().emotion.key)
  for (const dispose of host.effects) { try { dispose() } catch { /* disposer */ } }
  rmSync(host.stateDir, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n== 目录与配置自检 ==')
{
  const keys = EMOTIONS.map((emo) => emo.key)
  check('情绪不重名', new Set(keys).size === keys.length)
  check('每种情绪都有语气规则', EMOTIONS.every((emo) => Array.isArray(emo.speech) && emo.speech.length >= 2))
  check('每种情绪都有行为倾向和表现/掩饰', EMOTIONS.every((emo) => emo.behavior?.length && emo.display && emo.mask))
  check('每种情绪都有表情包 tag', EMOTIONS.every((emo) => typeof emo.meme === 'string' && emo.meme.length > 0))
  check('每种情绪都有评价签名(平静除外)', EMOTIONS.filter((emo) => emo.key !== 'calm').every((emo) => Object.keys(emo.signal ?? {}).length >= 2))
  check('情绪数量够撑起一个人', EMOTIONS.length >= 30, `${EMOTIONS.length} 种`)
  check('性格六轴齐全', TRAITS.length === 6 && TRAITS.every((trait) => Number.isFinite(trait.base)))
  check('浓度分档覆盖 0-100', tierOf(0).key === 'faint' && tierOf(100).key === 'strong')
  check('默认配置完整', ['channels', 'react', 'heartbeat', 'feel', 'traits'].every((key) => key in DEFAULTS))
  const merged = mergeConfig({ react: { maxPerTurn: 5 }, traits: { neuroticism: 70 } })
  check('配置深合并(只覆盖给到的字段)', merged.react.maxPerTurn === 5 && merged.react.cooldownMin === DEFAULTS.react.cooldownMin && merged.traits.neuroticism === 70)
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`}(共 ${passed + failed} 项)`)
if (failed) process.exitCode = 1
