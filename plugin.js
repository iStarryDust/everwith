// dsh-fish-mood —— 给 agent 一副会变化的心情:情绪有半衰期,心情影响说话方式。
//
// 三层结构(细节在 lib/):
//   性格 traits  → 心情 mood → 情绪 emotion
//   周~月的设定    这几小时的底色   刚刚发生的事
//
// 这一层负责:往系统提示词里挂两块、注册三个工具、跑心跳、判会话身份。
//
// 两块提示词(拆开是为了提示缓存友好:静态段字节不变,实时段固定在最后):
//   fish-mood:rules  order 100  —— 静态规则,字节级不变(提示缓存友好)
//   fish-mood:now    order 9800 —— 实时状态块,固定模板,放在整段提示词的最后
//
// 三个工具:
//   mood_now   看自己现在什么心情(三层 + 为什么 + 关系 + 记忆)
//   mood_feel  记一笔心情 —— 注意是**申请**:引擎有配额、冷却、饱和,会把「实际生效多少」回给你
//   mood_diary 翻日记 / 写心里话 / 复盘
//
// 心跳(默认 10 分钟一次):情绪衰减 + 自己的小事 + 反刍 + 心情修复 + 深夜复盘。
// 骰子只在心跳里抛 —— 提示词渲染函数每个模型步骤都会跑,在那儿抛骰子等于「一说话就过日子」。

import { createHash, randomUUID } from 'node:crypto'
import * as voicePlugin from './lib/voice.js'
import { applyAsrRoutes } from './lib/asr-route.js'
import { isVoiceActive } from './lib/asr.js'
import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EMOTION_KEYS, EMOTION_MENU, TRAITS, resolveEmotion, tierOf } from './lib/catalog.js'
import { appraise } from './lib/appraise.js'
import {
  applyImpulse, catharsis, circadian, decay, dueRumination, loadState, maybeLifeEvent, maybeMoodRepair,
  nightlyReview, pruneState, remember, saveState, snapshot,
} from './lib/state.js'
import { channelOfSession, lastSpeaker, readUserMessages, reactToMessages, sessionEventsOf } from './lib/react.js'
import { RULES_TEXT, renderDiary, renderMoodReport, renderMoodSection } from './lib/prompt.js'

export const name = 'fish-mood'
/** tools 是硬依赖:没有工具注册表这个插件没有任何意义 */
// tools/agents: 情绪与分条说话；webServer/systemPrompt: 语音宿主（路由 + 提示词段落）
export const inject = ['tools', 'agents', 'webServer', 'systemPrompt']

/** 用来确认「正在跑的是哪一版」:热重载有延迟,diag 里会打出来 */
const PLUGIN_REV = '2026-11-02.4'
/** 情绪淡到这儿以下就当没有了(和 lib/catalog.js 的 FADE_OUT 一致) */
const FADE_OUT_LEVEL = 6

const DEFAULTS = {
  stateDir: '',
  promptEnabled: true,
  /** 状态块里每次重述的身份句(抗长会话漂移);空 = 用 lib/prompt.js 的默认文案 */
  identity: '',
  /**
   * 往哪些会话注入心情。
   * qq  = QQ 机器人(入站消息没有 rpcId);
   * web = Web/桌面(有 rpcId)—— 默认一起给;只用 Web 处理其他工作时可以关掉。
   * unknown = 判不出来时:装了 qqbot 工具就当 QQ。
   */
  channels: { qq: true, web: true, unknown: false },
  /** 情绪冲量:从会话消息里读「刚发生了什么」 */
  react: { enabled: true, maxPerTurn: 2, cooldownMin: 4, strongCooldownMin: 2, freshMinutes: 15 },
  /** 心跳:衰减 + 自己的小事 + 反刍 + 心情修复 + 深夜复盘 */
  heartbeat: { enabled: true, everyMinutes: 10, lifeChance: 0.1, minGapMinutes: 45, rumination: true, moodRepair: true, review: true },
  /** 自己记心情的配额:防止模型反复加码把情绪推上天(调研 §4) */
  feel: { maxPerHour: 4, maxPerDay: 12, maxJump: 25, cooldownMin: 2 },
  /** 分条说话:一条消息=一次开口,模型想接着说就在末尾留 marker,插件等一会儿再让它开下一轮 */
  /**
   * 通话模式：消息里带前缀（比如「--当前正在实时语音通话-- 喂」）就切换成说话的口气。
   * 语音识别把话转成文字发过来时，模型分不清这是"说"还是"打" —— 于是照常写
   * Markdown、长长一段、还爱总结。通话模式就是把这个差别告诉它。
   */
  callMode: {
    enabled: true,
    prompt: '',
  },
  multiTurn: {
    enabled: true,
    maxRounds: 3,
    marker: '<!--more-->',
    charsPerSec: 15,
    jitterMs: 800,
    prompt: '<continue>（刚才那条已经发出去了。想再说一句就接着发,不用重新开头;没什么好说的就放着。）</continue>',
  },
  /** 性格基线覆盖,例如 { neuroticism: 70 } */
  traits: {},
  /**
   * 亲密尺度:0 日常(不主动提性) / 1 暧昧(可以调情,不写过程) / 2 露骨(完整)。
   * 默认 1;切换只认显式配置,不从对话里猜。
   */
  intimacy: { level: 1 },
}

/** 工具输出统一成 { text }:模型看 render,程序调用方拿规范值,两边一致 */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  // 契约:render 必须返回 ContentBlock[](dsh-tools 的 ToolOutput.render 签名)
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

// 分条说话:告诉模型怎么标记"还没说完"
// 通话口气不再由插件写死:标题换成「【正在通电话】」就够,要额外的口气再配 callMode.prompt。
// 注意不要再写「语气用标签」这类规则 —— 语音格式那一段已经管了。

/**
 * 分条说话只讲「怎么分条」,不规定口气和内容。
 *   · 口气归配置(callMode.prompt)或人格提示词;
 *   · 内容归人格提示词;
 *   · 这里只负责:一条一句、要不要接着说、怎么标。
 * 标题跟着通话状态换 —— 在电话里和坐在旁边,是两种场景。
 */
const MULTI_TURN_RULES = [
  '一条一句。这一条只写一句,写完就停。',
  '还想说下一句,在最后另起一行写 <!--more-->,然后停下来 —— 标记下面不写任何内容,',
  '会再给一次开口的机会。不想说了,就不写标记。',
  '',
  '说几句看当时有多少话,不用凑。',
]

const MULTI_TURN_FORMAT = [
  '格式对照:',
  '  对: 这一句 / 换行 / <!--more--> / 到此为止',
  '  错: 这一句 / 换行 / <!--more--> / 又接下一句 —— 标记下面不该有字',
]

/** 分条提示词:标题按场景换,规则不变 */
const multiTurnText = (inCall) =>
  [inCall ? '【正在通电话】' : '【在身边说话】', ...MULTI_TURN_RULES, '', ...MULTI_TURN_FORMAT].join('\n')

export function mergeConfig(config = {}) {
  const merged = { ...DEFAULTS, ...config }
  merged.channels = { ...DEFAULTS.channels, ...(config.channels ?? {}) }
  merged.react = { ...DEFAULTS.react, ...(config.react ?? {}) }
  merged.heartbeat = { ...DEFAULTS.heartbeat, ...(config.heartbeat ?? {}) }
  merged.feel = { ...DEFAULTS.feel, ...(config.feel ?? {}) }
  merged.intimacy = { ...DEFAULTS.intimacy, ...(config.intimacy ?? {}) }
  merged.traits = { ...(config.traits ?? {}) }
  return merged
}

export function apply(ctx, config = {}) {
  const settings = mergeConfig(config)
  const stateDir = settings.stateDir || join(homedir(), '.dsh', 'fish-mood')
  const log = (level, text) => {
    try {
      const logger = ctx.logger ?? ctx.get?.('logger')
      if (logger && typeof logger[level] === 'function') logger[level](text)
      else console.log(`[fish-mood] ${text}`)
    } catch {
      /* 日志失败不连坐 */
    }
  }

  /** 内存里一份账本:多会话并发时不会互相踩;写盘走原子写 */
  let state = loadState(stateDir)
  for (const [key, value] of Object.entries(settings.traits)) {
    if (TRAITS.some((trait) => trait.key === key) && Number.isFinite(Number(value))) state.traits[key] = Number(value)
  }
  // 亲密尺度以配置为准(账本里那份只是缓存)
  if (Number.isFinite(Number(settings.intimacy?.level))) {
    state.intimacy = { ...(state.intimacy ?? {}), level: Math.max(0, Math.min(2, Math.round(Number(settings.intimacy.level)))) }
  }
  const commit = () => {
    pruneState(state)
    return saveState(stateDir, state)
  }

  /** 审计日志:每次情绪变动都留一行,用来复盘「有没有单调上升不回落」(调研 §4) */
  const audit = (entry) => {
    try {
      appendFileSync(join(stateDir, 'audit.jsonl'), `${JSON.stringify({ at: Date.now(), rev: PLUGIN_REV, ...entry })}\n`)
    } catch {
      /* 写不进去不影响插件 */
    }
  }

  /**
   * 启动痕迹:证明「这一版真的被加载了」。
   * 桌面端把宿主 stdout 收走,而热重载又可能命中 ESM 缓存(重新 apply 了旧模块),
   * 所以只有落盘的一行字算数 —— fish-feed 给 qqbot 打补丁时也是这么确认的。
   */
  try {
    appendFileSync(join(stateDir, 'load.log'), `${new Date().toISOString()} rev ${PLUGIN_REV} pid ${process.pid} node ${process.versions.node}\n`)
  } catch {
    /* 写不进去不影响插件 */
  }

  // ── 会话 → 会话键 / 会话身份 ─────────────────────────────────────────────
  /** qqbot 的会话管理器:正规服务 + 进程级后门(fish-feed 踩过的两条路) */
  const sessionManager = () => {
    try {
      const viaCtx = ctx.get('qqbot-sessions')
      if (viaCtx) return viaCtx
    } catch {
      /* 服务不可见,试后门 */
    }
    try {
      return globalThis[Symbol.for('dsh.qqbot-sessions')] ?? undefined
    } catch {
      return undefined
    }
  }

  /** 和 dsh-qqbot 的 SessionManager.deriveSessionId 保持一致 */
  const derivedSessionId = (key) => {
    const hash = createHash('sha256').update(key).digest('hex')
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
  }

  /** 会话记录查得慢(要翻文件),按 sessionId 缓存一分钟 */
  const peerCache = new Map()
  const peerOf = (sessionId) => {
    if (!sessionId) return null
    const hit = peerCache.get(sessionId)
    if (hit && Date.now() - hit.at < 60_000) return hit.peer
    let peer = null
    const record = sessionManager()?.findBySessionId?.(sessionId)
    if (record?.peerId) {
      peer = { scope: record.scope, peerId: record.peerId, senderId: record.senderId }
    } else {
      try {
        const prefs = JSON.parse(readFileSync(join(homedir(), '.dsh-qqbot', 'model-prefs.json'), 'utf8'))
        for (const [key, id] of Object.entries(prefs?.sessionIds ?? {})) {
          if (id !== sessionId && derivedSessionId(key) !== sessionId) continue
          const [, , scope, peerId] = key.split(':')
          if (!scope || !peerId) continue
          peer = { scope, peerId }
          break
        }
      } catch {
        /* 文件不在/读不动就算了 */
      }
    }
    peerCache.set(sessionId, { at: Date.now(), peer })
    return peer
  }

  /**
   * 这个会话是谁:键用 `scope:peerId`(同一个群 `/new` 之后也还是同一个群,
   * 关系账不该重开一份),拿不到就退回 sessionId。
   */
  const convInfoOf = (session) => {
    const sessionId = String(session?.id ?? '')
    const peer = sessionId ? peerOf(sessionId) : null
    if (peer?.peerId) {
      const short = String(peer.peerId).slice(0, 8)
      return {
        conv: `${peer.scope}:${peer.peerId}`,
        label: peer.scope === 'group' ? `群 ${short}` : `私聊 ${short}`,
        peer,
        sessionId,
      }
    }
    // DSH 的会话 id 形如 `session-30e8fa99-...`：先剥掉 `session-` 前缀再取 8 位，
    // 否则截出来的永远是 `session-`，标签没有信息量。
    const shortId = sessionId.replace(/^session-/, '').slice(0, 8)
    return { conv: sessionId, label: shortId ? `会话 ${shortId}` : '', peer: null, sessionId }
  }

  /** 宿主装了 dsh-qqbot(qqbot_send_file 在那个 agent 的工具表里) */
  const hasQqbotTool = (agent) => {
    try {
      const tools = ctx.get('tools')
      if (!tools?.get || !agent) return false
      if (tools.get('qqbot_send_file', agent)) return true
      return Boolean(agent.ctx && tools.get('qqbot_send_file', agent.ctx))
    } catch {
      return false
    }
  }

  const sessionOf = (source) => {
    try {
      return source?.agent?.session ?? source?.session ?? null
    } catch {
      return null
    }
  }

  const channelEnabled = (channel, channels) => {
    if (channel === 'qq') return channels.qq !== false
    if (channel === 'web') return channels.web !== false
    return channels.unknown === true
  }

  /** 关系账里按昵称/ID 找一个人 */
  const findPersonKey = (needle) => {
    const text = String(needle ?? '').trim()
    if (!text) return ''
    if (state.people?.[text]) return text
    for (const [key, row] of Object.entries(state.people ?? {})) {
      if (row.name && (row.name === text || row.name.includes(text) || text.includes(row.name))) return key
    }
    return text
  }

  /**
   * 把状态推到「现在」,顺便听一耳朵这一轮新到的话。
   * 系统提示词段的渲染函数和几个工具都走这里 —— 拿到的一定是此刻的心情。
   *
   * 「新到」有两个条件:seq 比上次读过的靠后,而且**是最近 15 分钟内的**。
   * 后一条是为了不翻旧账:插件刚装上、会话刚 resume 回来时,
   * 历史里几十条旧消息不该一起冲上来改她的心情。
   */
  const tickState = (session, { react = true, life = false, extra = true } = {}) => {
    const now = Date.now()
    decay(state, now)
    let applied = []
    let event = null
    let cursorMoved = false
    if (session && react && settings.react.enabled !== false) {
      const info = convInfoOf(session)
      const seen = Number(state.seen[info.sessionId]) || 0
      const messages = readUserMessages(session, { since: seen })
      if (messages.length > 0) {
        state.seen[info.sessionId] = messages[messages.length - 1].seq
        cursorMoved = true
        const freshMs = Math.max(1, Number(settings.react.freshMinutes) || 15) * 60_000
        const fresh = messages.filter((msg) => !msg.time || now - msg.time <= freshMs)
        if (fresh.length > 0) {
          applied = reactToMessages(state, fresh, {
            conv: info.conv,
            convLabel: info.label,
            now,
            maxPerTurn: settings.react.maxPerTurn,
            cooldownMin: settings.react.cooldownMin,
            strongCooldownMin: settings.react.strongCooldownMin,
          })
          for (const item of applied) {
            log('info', `心情被带动:${item.why || item.rule} → ${state.emotion.key}(${Math.round(state.emotion.intensity)})`)
            audit({ kind: 'react', rule: item.rule, key: state.emotion.key, applied: item.intensity ?? 0, why: item.why })
          }
        }
      }
    }
    // 自己的小事只在心跳里抛骰子:渲染函数每次模型步骤都会被调,
    // 在那儿抛骰子等于「一说话就过日子」,频率会高得离谱。
    if (life && settings.heartbeat.enabled !== false) {
      const pick = maybeLifeEvent(state, now, {
        chance: settings.heartbeat.lifeChance,
        minGapMin: settings.heartbeat.minGapMinutes,
      })
      if (pick) {
        const judged = appraise(
          { kind: 'life', why: pick.text, strength: 0.55, dims: pick.dims },
          { traits: state.traits, energy: (state.core.energy ?? 55) / 100, hunger: state.drives.hunger, load: (state.drives.fatigue ?? 0) * 0.5 },
        )
        if (judged.key !== 'calm') {
          const out = applyImpulse(state, { key: judged.key, intensity: judged.intensity, why: pick.text, source: 'life', stimulus: `life:${pick.id}`, dims: judged.dims }, now)
          if (out) {
            event = out
            remember(state, { kind: 'life', key: out.key, intensity: out.intensity, why: pick.text }, now)
            log('info', `自己的小事:${pick.text} → ${out.key}(${out.intensity})`)
            audit({ kind: 'life', id: pick.id, key: out.key, applied: out.intensity, why: pick.text })
          }
        }
      }
    }
    // 反刍:没消化的事过一阵子自己冒出来
    if (extra && settings.heartbeat.rumination !== false) {
      const due = dueRumination(state, now)
      if (due) {
        const out = applyImpulse(state, due, now)
        if (out) {
          event = event ?? out
          log('info', `又想起一件事:${due.why} → ${out.key}(${out.intensity})`)
          audit({ kind: 'rumination', key: out.key, applied: out.intensity, why: due.why })
        }
      }
    }
    // 心情修复:底色差久了,她自己找点乐子
    if (extra && settings.heartbeat.moodRepair !== false) {
      const repair = maybeMoodRepair(state, now)
      if (repair) {
        event = event ?? repair
        remember(state, { kind: 'life', key: repair.key, intensity: repair.intensity, why: repair.why }, now)
        audit({ kind: 'repair', key: repair.key, applied: repair.intensity, why: repair.why })
      }
    }
    // 深夜复盘:一天一次
    if (extra && settings.heartbeat.review !== false) {
      const review = nightlyReview(state, now)
      if (review) {
        log('info', `深夜复盘:${review.text}`)
        audit({ kind: 'review', why: review.text, released: review.released })
      }
    }
    // 心情动了、或者「读到哪」往前走了,就落盘。
    // 游标也必须落盘:不然插件一重载,最近 15 分钟的消息会被重新读一遍、再冲一次情绪。
    if (applied.length > 0 || event || cursorMoved) commit()
    return { now, applied, event }
  }

  /** 一次渲染/工具调用要的完整视角 */
  const viewOf = (session, now = Date.now()) => {
    const info = convInfoOf(session)
    const person = lastSpeaker(session)
    const view = snapshot(state, { now, conv: info.conv, person })
    view.crisis = state.flags?.crisis && now - state.flags.crisis.at < 2 * 3_600_000 ? state.flags.crisis : null
    view.identity = settings.identity || ''
    return { info, view }
  }

  // ── 系统提示词 ──────────────────────────────────────────────────────────
  /**
 * 这个会话现在是不是在通话。
 *
 * 判据：最后一条用户消息里带着通话前缀。带就是通话中，不带就是挂断。
 * 不用超时 —— 不打字时没有新消息，状态自然保持；一旦打字（不带前缀），
 * 下一条就自动退出。这比计时更贴近「实时开/挂」。
 */
  /**
   * 这个会话现在是不是在通话。
   *
   * 判据：最后一条用户消息里带着通话前缀。带就是通话中，不带就是挂断。
   * 不用超时 —— 不打字时没有新消息，状态自然保持；一旦打字（不带前缀），
   * 下一条就自动退出。这比计时更贴近「实时开/挂」。
   */
  /**
   * 正在通话的会话。
   *
   * 由客户端那个通话按钮通过 POST /api/spoon-companion/call 写进来，
   * 点一下接通、再点一下挂断 —— 真正的"实时开/挂"，不靠消息前缀也不靠超时。
   * 只放内存：通话是短时状态，重启就该断开，不需要持久化。
   */
  const callSessions = new Set()
  /**
   * 不分会话的总开关。客户端按钮拿不到 sessionId 时就走这个 ——
   * 单会话场景下够用，多会话时各会话互不影响。
   */
  let callGlobal = false
  /** 最近一次开关请求的原始 body，排查用（会通过 GET 暴露） */
  let lastCallBody = null

  /** 客户端按钮的开关通道。挂不上不影响别的，只是按钮没反应。 */
  ctx.effect(() => {
    const webServer = ctx.webServer ?? ctx.get('webServer')
    if (!webServer?.register) return undefined
    const reply = (res, code, payload) => {
      try {
        res.statusCode = code
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(payload))
      } catch { /* ignore */ }
    }
    // 刷新页面后按钮要知道当前状态
    const statusRoute = {
      method: 'GET',
      path: '/api/spoon-companion/call',
      handler: async (_req, res) => {
        const query = String(_req?.url ?? '')
        const m = /[?&]sessionId=([^&]+)/.exec(query)
        const id = m ? decodeURIComponent(m[1]) : ''
        const on = callGlobal || (id ? callSessions.has(id) : false)
        reply(res, 200, { ok: true, on, lastBody: lastCallBody, global: callGlobal })      },
    }
    const route = {
      method: 'POST',
      path: '/api/spoon-companion/call',
      handler: async (req, res) => {
        try {
          let raw = ''
          for await (const chunk of req) raw += chunk
          const body = raw ? JSON.parse(raw) : {}
          log('info', `通话开关收到: ${JSON.stringify(body)}`)
          lastCallBody = body
          const id = String(body.sessionId ?? '')
          // 没有 sessionId 就当作全局开关（客户端拿不到会话标识时的兜底）
          if (!id) {
            const on = body.on !== false
            callGlobal = on
            reply(res, 200, { ok: true, on, scope: 'global' })
            return
          }
          if (body.on === false) callSessions.delete(id)
          else callSessions.add(id)
          reply(res, 200, { ok: true, on: callSessions.has(id) })
        } catch (error) {
          reply(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }
    try {
      const disposers = []
      disposers.push(webServer.register(statusRoute))
      disposers.push(webServer.register(route))
      return () => { for (const d of disposers) { try { d?.() } catch { /* ignore */ } } }
    } catch (error) {
      log('warn', `通话按钮通道注册失败:${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }, 'spoon-companion: call route')

  /**
   * 这个会话现在在不在通话里。
   * 三条任意一条成立就算：真的在送音频 / 客户端报了全局开关 / 这个会话被单独标过。
   */
  const inCallOf = (context) => {
    try {
      if ((settings.callMode ?? {}).enabled === false) return false
      const session = sessionOf(context)
      if (!session) return false
      const id = String(session.id ?? '')
      let voiceActive = false
      try {
        voiceActive = isVoiceActive()
      } catch {
        voiceActive = false
      }
      return voiceActive || callGlobal || Boolean(id && callSessions.has(id))
    } catch {
      return false
    }
  }

  /**
   * 通话时额外插的那一句话。默认不插 —— 通话场景已经由分条提示词的标题
   * 「【正在通电话】」说清了,再写一遍只会重复。要加自己的口气,配 callMode.prompt。
   */
  const callSectionText = (context) => {
    try {
      const cfg = settings.callMode ?? {}
      if (cfg.enabled === false) return ''
      if (settings.promptEnabled === false) return ''
      const session = sessionOf(context)
      if (!session) return ''
      if (!inCallOf(context)) return ''
      return String(cfg.prompt ?? '').trim()
    } catch {
      return ''
    }
  }

  const channelOf = (context) => {
    try {
      const agent = context?.agent ?? context?.scope ?? null
      const session = sessionOf(context)
      if (!session) return null
      const channel = channelOfSession(session, { hasQqbot: hasQqbotTool(agent) })
      // 会话里还没有可读的用户消息时 channelOfSession 会返回 unknown，
      // 而 channels.unknown 默认是关的 —— 那样 rules/now 两段会整段变成空，
      // 表现出来就是"这个会话里插件好像没了"。判不出来就按 web 算。
      return channel === 'unknown' ? 'web' : channel
    } catch {
      return null
    }
  }

  /** 静态规则块:字节级不变(它在前缀里,一变缓存就废) */
  const rulesSectionText = (context) => {
    try {
      if (settings.promptEnabled === false) return ''
      const channel = channelOf(context)
      if (!channel || !channelEnabled(channel, settings.channels)) return ''
      return RULES_TEXT
    } catch {
      return ''
    }
  }

  /** 实时状态块:固定模板,放在提示词最后 */
  const stateSectionText = (context) => {
    try {
      if (settings.promptEnabled === false) return ''
      const session = sessionOf(context)
      if (!session) return ''
      const channel = channelOf(context)
      if (!channel || !channelEnabled(channel, settings.channels)) return ''
      const { now } = tickState(session)
      return renderMoodSection(viewOf(session, now).view)
    } catch (error) {
      // 这里绝不能抛:渲染函数抛了整份提示词就组装不出来
      log('warn', `心情段渲染失败(已跳过):${error instanceof Error ? error.message : String(error)}`)
      return ''
    }
  }

  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({
      name: 'fish-mood:rules',
      // 0 = 人设,500 = plan 策略:规则紧跟人设
      order: 100,
      text: rulesSectionText,
    }), 'fish-mood: rules section')
    scope.effect(() => scope.systemPrompt.section({
      name: 'fish-mood:now',
      // 9800:整段提示词的最后(9900 是结构化输出)。放最后是为了少打断前缀缓存
      order: 9800,
      text: stateSectionText,
    }), 'fish-mood: state section')

    scope.effect(() => scope.systemPrompt.section({
      name: 'fish-mood:turns',
      // 300:放在前段,别往末尾挤。
      // 试过挪到 9870(紧贴对话),结果连续说话完全不触发了 ——
      // 这段是"怎么写"的格式要求,不是"现在是什么状态",
      // 混到最后反而和语音格式那段打架。状态类的才该靠后。
      order: 300,
      text: (context) => {
        if (settings.multiTurn?.enabled === false) return ''
        return multiTurnText(inCallOf(context))
      },
    }), 'fish-mood: turns section')
    scope.effect(() => scope.systemPrompt.section({
      name: 'fish-mood:call',
      // 9890:压在所有块之后,紧贴对话 —— 通话时"回短句"这条最容易被无视,
      // 离得越近越管用。(9900 留给结构化输出,别占)
      order: 9890,
      text: callSectionText,
    }), 'fish-mood: call section')
  })

  // ── 分条说话 ────────────────────────────────────────────────────────────
  // 一条消息 = 一次开口。模型想接着说下一句,就在这条末尾留一行 [[more]];
  // 一轮说完(agent 进入 idle)时插件检查一次,有标记就等一会儿让它开下一轮。
  // 每轮是一个新回合,界面上是分开的 —— 这就是"多说几条"。
  ctx.inject(['agents'], (scope) => {
    const turns = settings.multiTurn ?? {}
    if (turns.enabled === false) return
    const maxRounds = Math.max(1, Number(turns.maxRounds) || 3)
    // 兜底值必须和提示词里写的标记一致。
    // 原来兜底是 [[more]]，提示词写 <!--more-->，一旦 settings 没带上 marker 就永远匹配不上。
    const marker = String(turns.marker || '<!--more-->')
    log('info', `分条说话:启用 marker=${JSON.stringify(marker)} maxRounds=${maxRounds} perSec=${Number(turns.charsPerSec) || 15}`)
    const perSec = Math.max(1, Number(turns.charsPerSec) || 15)
    const jitter = Math.max(0, Number(turns.jitterMs) || 0)
    const continueText = String(turns.prompt || '继续。')
    /** 每个会话连了几轮(含第一轮)。说完就清掉。 */
    const counted = new Map()

    /**
     * 这一轮给几次机会、间隔多松 —— 由当前情绪决定。
     * 情绪不改说什么,只改"说几句"和"隔多久"。
     */
    const emotionBudget = () => {
      const k = String(state.emotion?.key ?? 'calm')
      const intensity = Number(state.emotion?.intensity) || 0
      let rounds = maxRounds
      let speed = 1

      // 情绪够浓才起作用,淡淡的就按默认走
      if (intensity >= 26) {
        if (k === 'excited' || k === 'happy' || k === 'playful' || k === 'amused') {
          rounds = Math.max(rounds, 4)
          speed = 0.7 // 急,接得快
        } else if (
          k === 'sad' || k === 'down' || k === 'lonely' || k === 'disappointed' ||
          k === 'wronged' || k === 'tired' || k === 'sleepy'
        ) {
          rounds = 1 // 不想多话
        }
      }
      // 想说出去的时候,多给一次
      if (state.urges?.kind === 'share' && Number(state.urges.until) > Date.now()) {
        rounds = Math.max(rounds, 4)
        speed = Math.min(speed, 0.85)
      }
      return { rounds, speed, maxWaitMs: 8000 }
    }

    scope.effect(() => {
      const off = scope.on('agent/status', ({ agent, status }) => {
        if (status !== 'idle') return
        try {
          const session = agent?.session
          if (!session) {
            log('warn', '分条说话:idle 时拿不到 session（分叉/编辑重开的会话可能走过这里）')
            return
          }
          const key = String(session.id ?? '')

          // 找这一轮最后一条有正文的 assistant 消息
          const events = sessionEventsOf(session)
          let lastText = ''
          for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i]
            if (ev?.type !== 'assistant/message') continue
            const content = ev.data?.message?.content
            if (!Array.isArray(content)) continue
            const joined = content.filter((x) => x?.type === 'text').map((x) => x.text).join('')
            if (!joined.trim()) continue
            lastText = joined
            break
          }
          if (!lastText) { counted.delete(key); return }

          // 认两种：①末尾正好是标记　②标记出现在最后 120 字符内
          // 只用①的话，模型在标记后多打一个标点就会漏判，静默不续说。
          const tail = (lastText.trimEnd().split('\n').pop() ?? '').trim()
          const nearTail = lastText.trimEnd().slice(-120)
          const hasMarker = tail === marker || nearTail.includes(marker)
          if (!hasMarker) {
            // 打出来才知道是"模型没写标记"还是"标记被吃了"
            log(
              'info',
              `分条说话:末尾不是标记(session=${key.slice(0, 18)} tail=${JSON.stringify(tail.slice(0, 30))})`,
            )
            counted.delete(key)
            return
          }

          // 情绪决定"给几次机会"和"间隔松紧"
          const mood = emotionBudget()
          const used = counted.get(key) ?? 1
          if (used >= mood.rounds) { counted.delete(key); return }
          counted.set(key, used + 1)

          // 按上一段字数模拟"说完了再开口"的间隔
          const plain = lastText.split(marker).join('').trim()
          const typing = (plain.length / perSec) * 1000
          const wait = Math.min(
            mood.maxWaitMs,
            Math.round((typing + Math.random() * jitter) * mood.speed),
          )

          setTimeout(() => {
            try {
              agent.followup({
                id: randomUUID(),
                role: 'user',
                content: [{ type: 'text', text: continueText }],
                source: { kind: 'companion', round: used + 1 },
              })
            } catch (error) {
              counted.delete(key)
              log('warn', `分条说话:续说失败(${error instanceof Error ? error.message : String(error)})`)
            }
          }, wait)
        } catch (error) {
          log('warn', `分条说话:判断出错(已跳过)${error instanceof Error ? error.message : String(error)}`)
        }
      })
      return () => {
        counted.clear()
        off()
      }
    }, 'fish-mood: multi-turn')
  })

  // ── 工具 ────────────────────────────────────────────────────────────────
  const tools = ctx.get('tools')
  if (!tools?.register) {
    log('warn', 'tools 服务不可用,mood_* 工具未注册')
  } else {
    tools.register({
      name: 'mood_now',
      description:
        '看当前心情:哪种情绪、多浓、为什么(评价),还有心情底色(愉快度/精力)、性格、' +
        '身体(泛红/酥麻/想要/馋/困)、跟这个人处得怎么样、今天发生的小事、心里还记着的事。' +
        '面对「心情咋样」「怎么了」这类问题,或者要确定当前语气,用它。action=diag 是排障用的。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'now(默认)看心情 / diag 排障信息' },
          limit: { type: 'number', description: '心里记着的事看几条,默认 6' },
          person: { type: 'string', description: '可选:看某个人(填昵称或 openid)' },
        },
        required: [],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const session = sessionOf(exec)
        if (String(args.action ?? 'now').toLowerCase() === 'diag') {
          const info = convInfoOf(session)
          const channel = session ? channelOfSession(session, { hasQqbot: hasQqbotTool(exec?.agent) }) : '(没有 session)'
          const events = sessionEventsOf(session)
          const realUsers = events.filter((event) => event?.type === 'user/message' && event.data?.source?.kind === 'user')
          const lastReal = realUsers[realUsers.length - 1]
          const pending = session ? readUserMessages(session, { since: Number(state.seen[info.sessionId]) || 0 }) : []
          const lines = [
            `fish-mood rev ${PLUGIN_REV}(三层:情绪/心情/性格)`,
            `状态文件:${join(stateDir, 'state.json')} · 审计:${join(stateDir, 'audit.jsonl')}`,
            `当前会话:${info.conv || '(拿不到)'}${info.label ? `(${info.label})` : ''} · 渠道 ${channel}${channelEnabled(channel, settings.channels) ? '(会注入)' : '(不注入:channels 关了)'}`,
            `事件 ${events.length} 条 · 真实用户消息 ${realUsers.length} 条${lastReal ? ` · 最后一条 seq ${lastReal.seq}(${new Date(lastReal.time).toLocaleTimeString('zh-CN', { hour12: false })})` : ''}`,
            `读到哪:seq ${state.seen[info.sessionId] ?? '(还没开始听)'} · 这轮待读 ${pending.length} 条`,
            `情绪:${state.emotion.key}(${Math.round(state.emotion.intensity)})${state.emotion.why ? ` · ${state.emotion.why}` : ''}`,
            `心情:${viewOf(session).view.mood.label} · 底色:愉快度 ${Math.round(state.core.valence)} · 精力 ${Math.round(state.core.energy)} · ${circadian(new Date()).label}`,
            `驱动:黏 ${((state.drives.cling ?? 0) * 100).toFixed(0)}% · 馋 ${((state.drives.craving ?? 0) * 100).toFixed(0)}% · 躁 ${((state.drives.restless ?? 0) * 100).toFixed(0)}% · 欠 ${((state.drives.undone ?? 0) * 100).toFixed(0)}% · 软 ${((state.drives.softness ?? 0) * 100).toFixed(0)}% · 想要 ${((state.drives.desire ?? 0) * 100).toFixed(0)}%`,
            `身体:泛红 ${((state.body?.flush ?? 0) * 100).toFixed(0)}% · 酥麻 ${((state.body?.tingle ?? 0) * 100).toFixed(0)}% · 体温 ${((state.body?.warmth ?? 0.5) * 100).toFixed(0)}% · 场景 ${state.scene?.phase ?? 'daily'}(尺度 ${state.intimacy?.level ?? 1}) · 饿 ${((state.drives.hunger ?? 0) * 100).toFixed(0)}% · 困 ${((state.drives.fatigue ?? 0) * 100).toFixed(0)}%`,
            `统计:冲量 ${state.stats.impulses ?? 0} · 自记的 ${state.stats.feels ?? 0} · 小事 ${state.stats.lifeEvents ?? 0} · 反刍 ${state.stats.ruminated ?? 0} · 修复 ${state.stats.repairs ?? 0} · 复盘 ${state.stats.reviews ?? 0} · 性格微调 ${state.stats.traitShifts ?? 0} 次`,
            `表现层:${state.emotion.hidden ? '憋着(表面装没事)' : '直接写在脸上'} · 累计憋着 ${Math.round(state.stats.maskedMinutes ?? 0)} 分钟 · 情绪续命 ${state.emotion.revives ?? 0} 次 · 待反刍 ${state.rumination.length} 条`,
            `关系账:${Object.keys(state.convs ?? {}).length} 个会话 · ${Object.keys(state.people ?? {}).length} 个人 · 日记 ${state.diary.length} 条 · 记忆点 ${state.memories.length} 个`,
          ]
          return { text: lines.join('\n') }
        }
        const now = Date.now()
        decay(state, now)
        const person = args.person ? findPersonKey(String(args.person)) : lastSpeaker(session)
        const info = convInfoOf(session)
        const view = snapshot(state, { now, conv: info.conv, person })
        view.crisis = state.flags?.crisis && now - state.flags.crisis.at < 2 * 3_600_000 ? state.flags.crisis : null
        const lines = [renderMoodReport(view)]
        const limit = Math.max(1, Math.min(20, Number(args.limit) || 6))
        const rows = (state.diary ?? []).slice(-limit)
        if (rows.length) {
          lines.push('', `日记(最近 ${rows.length} 条):`, renderDiary(rows))
        }
        const people = Object.entries(state.people ?? {})
          .sort((a, b) => (b[1].lastAt ?? 0) - (a[1].lastAt ?? 0))
          .slice(0, 5)
        if (people.length) {
          lines.push('', '关系账(最近来往的几个人):')
          for (const [key, row] of people) {
            const notes = (row.notes ?? []).slice(-3)
            lines.push(`- ${row.name || key}:暖度 ${Math.round(row.warmth)} · 亲密度 ${Math.round(row.closeness)} · 信任 ${Math.round(row.trust)}${notes.length ? ` · 记着「${notes.join('」「')}」` : ''}`)
          }
        }
        return { text: lines.join('\n') }
      },
    })

    tools.register({
      name: 'mood_feel',
      description:
        '记一笔心情 —— 这是一次**申请**:引擎有配额和饱和,会回报「实际生效多少」。' +
        `情绪用这些词:${EMOTION_MENU}。` +
        '被戳到、被感动、真的烦了、被人哄好了,用这个;要看当前心情用 mood_now。' +
        '为什么(why)写短一句,别写成作文。',
      parameters: {
        type: 'object',
        properties: {
          emotion: { type: 'string', description: '哪种情绪:英文 key 或中文名,完整列表见工具描述' },
          intensity: { type: 'number', description: '多浓,1-100,默认 45(淡淡的 20 / 挺浓 60 / 上头 85)' },
          why: { type: 'string', description: '一句为什么,短' },
          person: { type: 'string', description: '可选:跟谁有关(昵称或 openid)' },
          warmth: { type: 'number', description: '可选:-20..20,这件事对这个人暖了多少/凉了多少' },
          show: { type: 'boolean', description: '可选:想不想让对方看出来。false = 会嘴硬、装没事(感受和表现是两回事)' },
        },
        required: ['emotion'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const session = sessionOf(exec)
        const now = Date.now()
        const emo = resolveEmotion(args.emotion)
        if (!emo || emo.key === 'calm') {
          return { text: `认不出「${args.emotion}」这个情绪。能用的是:${EMOTION_KEYS.join(' / ')}(也可以直接写中文名)` }
        }
        decay(state, now)
        // 配额:防止「反复加码把情绪推上天」(MAST FM-1.3/1.5 那类失败)
        state.stats.feelLog = (state.stats.feelLog ?? []).filter((at) => now - at < 24 * 3_600_000)
        const lastHour = state.stats.feelLog.filter((at) => now - at < 3_600_000).length
        const lastDay = state.stats.feelLog.length
        if (lastHour >= settings.feel.maxPerHour || lastDay >= settings.feel.maxPerDay) {
          return { text: `今天记的够多了(一小时 ${lastHour} 次 / 一天 ${lastDay} 次,上限 ${settings.feel.maxPerHour} / ${settings.feel.maxPerDay})。心情不是点出来的,先照现在这个来。` }
        }
        const requested = Math.max(1, Math.min(100, Number(args.intensity) || 45))
        const cur = state.emotion
        const sameEmotion = cur.key === emo.key && cur.intensity > 0
        const gapMin = (now - (cur.updatedAt || 0)) / 60_000
        if (sameEmotion && gapMin < settings.feel.cooldownMin) {
          return { text: `刚记过「${emo.name}」了(${Math.round(cur.intensity)}/100),让它待一会儿 —— ${settings.feel.cooldownMin} 分钟内不重复加码。` }
        }
        // 饱和:平的时候允许一次强情绪;同一种情绪只让它往上磨一点;换情绪可以压过去,但不许尖峰
        const cap = cur.intensity <= FADE_OUT_LEVEL
          ? Math.max(50, requested)
          : sameEmotion
            ? Math.round(cur.intensity + settings.feel.maxJump * 0.5)
            : Math.max(30, Math.round(cur.intensity + settings.feel.maxJump * 0.6))
        const applied = Math.min(requested, cap)
        const out = applyImpulse(state, {
          key: emo.key,
          intensity: applied,
          why: String(args.why ?? '').slice(0, 60),
          source: 'self',
          person: String(args.person ?? ''),
          stimulus: `feel:${emo.key}`,
          dims: { valence: emo.valence, relevance: 0.7, arousal: emo.arousal, agency: 'none' },
        }, now)
        state.stats.feelLog.push(now)
        if (!out) {
          commit()
          return { text: '记下了(太淡了,没掀起什么)。' }
        }
        if (args.show === false) state.emotion.hidden = true
        const personKey = args.person ? findPersonKey(String(args.person)) : ''
        if (personKey && Number.isFinite(Number(args.warmth))) {
          const row = state.people[personKey] ?? { name: String(args.person), warmth: 0, closeness: 25, trust: 50, bank: 0, notes: [], lastAt: now, count: 0 }
          row.warmth = Math.max(-100, Math.min(100, row.warmth + Number(args.warmth)))
          row.closeness = Math.max(0, Math.min(100, row.closeness + Number(args.warmth) * 0.3))
          state.people[personKey] = row
        }
        remember(state, { kind: 'feel', key: out.key, intensity: out.intensity, why: String(args.why ?? ''), person: personKey }, now)
        audit({ kind: 'feel', key: out.key, requested, applied: out.intensity, clamped: applied < requested, why: String(args.why ?? ''), hidden: args.show === false })
        commit()
        const tier = tierOf(out.intensity)
        const notes = []
        if (applied < requested) notes.push(`申请 ${requested},实际 ${out.intensity}(饱和了)`)
        if (out.suppressed) notes.push('刚才那件事还压着,这次只是把它削了一点')
        if (args.show === false) notes.push('记成「不让人看出来」')
        return {
          text: `记下了:${out.emotion.name}(${tier.label} ${out.intensity}/100)${args.why ? ` · ${args.why}` : ''}` +
            `${notes.length ? `\n(${notes.join(';')})` : ''}\n接下来就按这个心情说话 —— 语气跟着走,但别把心情说出来。它会自己淡下去。`,
        }
      },
    })

    tools.register({
      name: 'mood_diary',
      description:
        '翻自己的心情日记,或者往里写一条。action=read(默认)按天看最近记了什么(心情、起因、谁);' +
        'action=write 写一条自己的事或一句心里话 —— 只留给自己,不发出去,写下来会舒服一点(情绪会真的降一点);' +
        'action=reflect 现在就把这一天过一遍(平时是深夜自动复盘)。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'read(默认)翻日记 / write 写一条 / reflect 复盘' },
          text: { type: 'string', description: 'action=write 时写的内容(一句心里话,或者今天发生的一件小事)' },
          mood: { type: 'string', description: 'action=write 时可选:写的时候是什么心情' },
          days: { type: 'number', description: 'action=read:看最近几天的,默认 3' },
          query: { type: 'string', description: 'action=read:按关键词翻(比如某个人的名字、某件事)' },
          limit: { type: 'number', description: 'action=read:最多几条,默认 20' },
        },
        required: [],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const now = Date.now()
        decay(state, now)
        const action = String(args.action ?? 'read').toLowerCase()
        if (action === 'write') {
          const text = String(args.text ?? '').trim()
          if (!text) return { text: '(没写内容)' }
          const mood = args.mood ? resolveEmotion(args.mood) : null
          if (mood && mood.key !== 'calm') {
            applyImpulse(state, { key: mood.key, intensity: 30, why: text.slice(0, 40), source: 'self', stimulus: 'diary' }, now)
          }
          const released = catharsis(state, now, 1)
          remember(state, { kind: 'feel', key: state.emotion.key, intensity: 0, why: text.slice(0, 120) }, now)
          audit({ kind: 'diary-write', released, why: text.slice(0, 60) })
          commit()
          return { text: `写下了${released ? `(心里松了 ${released} 分)` : ''}。这条只有自己看得到。` }
        }
        if (action === 'reflect') {
          state.lastReviewDay = ''
          // 她主动要复盘:不受「只在深夜复盘」的时间窗限制,但当天还是只一次
          const review = nightlyReview(state, now, { force: true })
          commit()
          return { text: review ? `复盘完了:${review.text}${review.released ? `(放下了 ${review.released} 分)` : ''}` : '(今天已经复盘过了)' }
        }
        const days = Math.max(1, Math.min(30, Number(args.days) || 3))
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 20))
        const query = String(args.query ?? '').trim()
        let rows = (state.diary ?? []).filter((row) => now - row.at <= days * 24 * 3_600_000)
        if (query) rows = rows.filter((row) => String(row.text ?? '').includes(query) || String(row.person ?? '').includes(query))
        rows = rows.slice(-limit)
        if (!rows.length) return { text: query ? `(最近 ${days} 天里没找到「${query}」)` : `(最近 ${days} 天没记什么)` }
        return { text: `最近 ${days} 天,记了 ${rows.length} 条:\n${renderDiary(rows)}` }
      },
    })
  }

  // ── 心跳 ────────────────────────────────────────────────────────────────
  // 情绪会自己淡,小事会自己发生,没消化的事会自己冒出来 —— 这些不需要有人跟她说话。
  if (settings.heartbeat.enabled !== false) {
    const everyMs = Math.max(1, Number(settings.heartbeat.everyMinutes) || 10) * 60_000
    const beat = () => {
      try {
        tickState(null, { react: false, life: true })
        commit()
      } catch (error) {
        log('warn', `心跳出错(已跳过):${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const first = setTimeout(beat, 30_000)
    const timer = setInterval(beat, everyMs)
    ctx.effect(() => () => {
      clearTimeout(first)
      clearInterval(timer)
    }, 'fish-mood: heartbeat')
  }

  // ── 语音 ────────────────────────────────────────────────────────────────
  // 由 companion-voice 合并进来：注册 /api/companion-voice/* 路由、语音提示词段落、
  // 以及与客户端的播放通道。它自己管自己的 ctx.effect，挂不上也不该拖垮情绪系统。
  try {
    // 语音识别：客户端录音 → 本地 sherpa-onnx → 文字。挂不上不影响朗读。
    ctx.effect(() => applyAsrRoutes(ctx, log), 'spoon-companion: asr routes')

    voicePlugin.apply(ctx)
  } catch (error) {
    log('warn', `语音半边挂载失败（情绪系统继续工作）:${error instanceof Error ? error.message : String(error)}`)
  }
}

export { DEFAULTS, PLUGIN_REV }
export { renderMoodSection as moodSectionTextForTest, RULES_TEXT }
