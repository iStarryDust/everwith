/**
 * 从 Chat 快照里读助手消息的正文与轮次状态。
 *
 * slot `conversation.chat.assistant-actions` 只给 messageId，其余都得自己从快照取：
 * legacy.nodes 是身份稳定的节点数组，适合做选择器。
 *
 * 为什么要按「轮」而不是按「条」：
 *   DSH 一轮里可能有多步（思考 → 工具 → 再回答），每一步都会产生一条 assistant 消息。
 *   自动朗读应当把**整轮**拼起来播一次，而不是逐条播、也不是只播最后一步。
 *
 * 「是否说完」的判据（不依赖内部 turnEnds Map，那个 key 是对象、不可靠）：
 *   legacy.nodes 本身就是 finalized 列表（源码里 `snapshot()` 返回 `nodes: this.finalized`），
 *   正在生成的那条单独放在 `legacy.partial`。因此：
 *     在 nodes 里 且 不是 partial 指向的那条  =  已经说完。
 */
import type { ChatSnapshot, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'

/** 一条助手消息的可见文本（只取 text 块，跳过思维链与工具调用）。 */
export function assistantTextOf(snapshot: ChatSnapshot, messageId: string): string {
  for (const node of snapshot.legacy.nodes) {
    if (node.kind !== 'assistant') continue
    if (node.messageId === undefined || String(node.messageId) !== messageId) continue
    const parts: string[] = []
    for (const block of node.blocks) {
      if (block.kind === 'text') parts.push(block.text)
    }
    return parts.join('\n\n').trim()
  }
  return ''
}

/** 轮次里的一条助手消息。 */
interface TurnNode {
  messageId: string
  /** 所属轮次标识（稳定字符串）。 */
  turnKey: string
  text: string
  /** 这条消息落定的时间戳（毫秒）；拿不到为 0。 */
  time: number
}

/** 归一化时间戳：兼容秒级与毫秒级。 */
function normalizeTime(raw: unknown): number {
  const t = Number(raw)
  if (!Number.isFinite(t) || t <= 0) return 0
  return t > 1e12 ? t : t * 1000
}

/**
 * 从 turn 上抽出稳定的标量标识。
 *
 * **不能直接 String(turn)**：turn 是对象，`String()` 永远得到 "[object Object]"，
 * 于是所有轮次的 key 都相同，第一轮播过之后后续全被去重挡掉
 * （这正是"自动播放只响一次"的原因）。
 */
function turnScalarId(turn: unknown): string {
  if (turn === undefined || turn === null) return ''
  if (typeof turn === 'string' || typeof turn === 'number') return String(turn)
  if (typeof turn === 'object') {
    const o = turn as Record<string, unknown>
    // 按可能性依次尝试：id / turn / index / seq / start.seq
    for (const k of ['id', 'turn', 'index', 'seq', 'key']) {
      const v = o[k]
      if (typeof v === 'string' || typeof v === 'number') return String(v)
    }
    const start = o.start as Record<string, unknown> | undefined
    if (start && (typeof start.seq === 'string' || typeof start.seq === 'number')) return String(start.seq)
    const end = o.end as Record<string, unknown> | undefined
    if (end && (typeof end.seq === 'string' || typeof end.seq === 'number')) return String(end.seq)
  }
  return ''
}

/** 收集快照里所有已落定的助手节点。 */
function turnNodes(snapshot: ChatSnapshot): TurnNode[] {
  const out: TurnNode[] = []
  for (const node of snapshot.legacy.nodes) {
    if (node.kind !== 'assistant') continue
    if (node.messageId === undefined) continue
    const parts: string[] = []
    for (const block of node.blocks) {
      if (block.kind === 'text') parts.push(block.text)
    }
    const turn = (node as { turn?: unknown }).turn
    out.push({
      messageId: String(node.messageId),
      // 优先用 turn 的标量 id；抽不到就留空，稍后按「本轮首个 messageId」补齐
      turnKey: turnScalarId(turn),
      text: parts.join('\n').trim(),
      time: normalizeTime((node as { time?: unknown }).time),
    })
  }

  // 抽不到 turn id 时，用相邻关系归组；分组完成后把 key 换成
  // 「该组**第一条**消息的 messageId」。
  // 用第一条而不是最后一条：一轮多步骤时，后面的消息陆续进来会改变"最后一条"，
  // 从而让 key 中途变化、触发重复播放；而"第一条"在本轮内始终不变。
  let fallback = 0
  let prevEmpty = false
  for (const n of out) {
    if (n.turnKey === '') {
      if (!prevEmpty) fallback++
      n.turnKey = `grp:${fallback}`
      prevEmpty = true
    } else {
      prevEmpty = false
    }
  }

  const firstOfGroup = new Map<string, string>()
  for (const n of out) if (!firstOfGroup.has(n.turnKey)) firstOfGroup.set(n.turnKey, n.messageId)
  for (const n of out) {
    const first = firstOfGroup.get(n.turnKey)
    if (first) n.turnKey = `turn@${first}`
  }
  return out
}

/** 当前正在流式输出的那条消息 id（没有则空串）。 */
function streamingMessageId(snapshot: ChatSnapshot): string {
  const partial = (snapshot.legacy as { partial?: unknown }).partial as
    | { messageId?: unknown }
    | null
    | undefined
  if (!partial || partial.messageId === undefined) return ''
  return String(partial.messageId)
}

/** 消息在本轮中的位置信息。 */
export interface AssistantMessageInfo {
  /** 自己这条的正文。 */
  text: string
  /** 已落定且不在流式中（这一轮说完了）。 */
  settled: boolean
  /** 是否是「最新一轮」的助手消息。 */
  inLatestTurn: boolean
  /** 是否是最新一轮里的最后一条（只有它负责触发自动朗读）。 */
  isLastOfLatestTurn: boolean
  /** 最新一轮的完整正文（本轮所有助手文本合并）。 */
  latestTurnText: string
  /** 最新一轮的标识（用于去重，一轮只播一次）。 */
  latestTurnKey: string
  /** 自己这条是否正在流式输出。 */
  streaming: boolean
  /** 这一轮最后一条的落定时间（毫秒，0 表示未知）。 */
  turnEndedAt: number
}

/** 读某条助手消息的正文、轮次归属与整轮文本。 */
export function assistantInfoOf(snapshot: ChatSnapshot, messageId: string): AssistantMessageInfo {
  const nodes = turnNodes(snapshot)
  const me = nodes.find((n) => n.messageId === String(messageId))

  const empty: AssistantMessageInfo = {
    text: me?.text ?? '',
    settled: false,
    inLatestTurn: false,
    isLastOfLatestTurn: false,
    latestTurnText: '',
    latestTurnKey: '',
    streaming: false,
    turnEndedAt: 0,
  }
  if (!me) return empty

  const last = nodes[nodes.length - 1]
  if (!last) return empty

  const latestKey = last.turnKey
  const inLatest = me.turnKey === latestKey
  const isLastOfLatest = last.messageId === String(messageId)

  // 本轮所有文本合并（按节点顺序）
  const merged = nodes
    .filter((n) => n.turnKey === latestKey)
    .map((n) => n.text)
    .filter((t) => t !== '')
    .join('\n')

  // 本轮最后一个节点的时间就是"这轮说完的时间"
  const turnEndedAt = last.time

  const streamingId = streamingMessageId(snapshot)
  const streaming = streamingId === String(messageId)

  return {
    text: me.text,
    // 在 finalized 列表里且不在流式中 = 这一轮已经说完
    settled: !streaming,
    inLatestTurn: inLatest,
    isLastOfLatestTurn: isLastOfLatest,
    latestTurnText: merged || me.text,
    latestTurnKey: latestKey,
    streaming,
    turnEndedAt,
  }
}

/** 订阅式读取某条助手消息的文本。 */
export function useAssistantText(useChat: UseChat, messageId: string): string {
  return useChat((snapshot: ChatSnapshot) => assistantTextOf(snapshot, messageId))
}

/** 订阅式读取正文、轮次归属与整轮文本。 */
export function useAssistantInfo(useChat: UseChat, messageId: string): AssistantMessageInfo {
  return useChat((snapshot: ChatSnapshot) => assistantInfoOf(snapshot, messageId))
}
