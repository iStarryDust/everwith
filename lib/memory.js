/**
 * 长期档案:一份 markdown,放在状态目录里,不衰减。
 *
 * 和 state.memories 的分工:
 *   - state.memories 记「发生了什么」,14 天过期,最多 12 条,情绪余温
 *   - memory.md 记「是什么」,永不过期,手写也能改,是前提
 *
 * 行的形状沿用 `- [YYYY-MM-DD HH:mm] 内容`,标题和空行原样保留,
 * 所以从别处粘过来的记忆不用重新排版。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ENTRY_RE = /^\s*[-*]\s*\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\]\s*(.+?)\s*$/

const pad = (n) => String(n).padStart(2, '0')

/** `2026-10-27 15:54` */
export function stamp(at = Date.now()) {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 一条内容 → 一行 */
export function formatEntry(content, at = Date.now()) {
  const body = String(content ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  if (!body) return ''
  return `- [${stamp(at)}] ${body}`
}

/** 整段文本 → 条目数组(保留行号,方便原地替换) */
export function parseEntries(text) {
  const lines = String(text ?? '').split('\n')
  const out = []
  lines.forEach((line, index) => {
    const m = line.match(ENTRY_RE)
    if (m) out.push({ index, at: m[1], content: m[2] })
  })
  return out
}

/** 去重用的归一化:大小写、空白、标点都抹平 */
const dedupeKey = (content) =>
  String(content ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[，。！？、；：,.!?;:]/g, '')

/**
 * 追加一条。同义条目只刷新时间戳,不新增一行。
 * @returns {{ text: string, added: boolean, refreshed: boolean }}
 */
export function appendEntry(text, content, at = Date.now()) {
  const body = String(content ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  if (!body) return { text: String(text ?? ''), added: false, refreshed: false }
  const lines = String(text ?? '').split('\n')
  const entries = parseEntries(lines.join('\n'))
  const key = dedupeKey(body)
  const hit = entries.find((e) => dedupeKey(e.content) === key)
  if (hit) {
    lines[hit.index] = formatEntry(hit.content, at)
    return { text: lines.join('\n'), added: false, refreshed: true }
  }
  // 末尾空行太多就压一压,再加
  let body2 = lines.join('\n').replace(/\n{3,}$/, '\n\n').replace(/\s+$/, '')
  if (body2) body2 += '\n\n'
  body2 += formatEntry(body, at) + '\n'
  return { text: body2, added: true, refreshed: false }
}

/**
 * 渲染成提示词。只取最近 limit 条,免得档案越写越长把上下文挤爆。
 * 返回空串表示"这段不该出现"。
 */
export function renderMemory(text, limit = 60) {
  const raw = String(text ?? '').trim()
  if (!raw) return ''
  const entries = parseEntries(raw)
  if (entries.length <= limit) return raw
  // 超长时保留开头的自由文本(标题之类) + 最近 limit 条
  const head = raw.split('\n').slice(0, entries[0]?.index ?? 0).join('\n').trim()
  const recent = entries.slice(-limit).map((e) => `- [${e.at}] ${e.content}`).join('\n')
  return [head, '', `(更早的 ${entries.length - limit} 条省略)`, recent].filter(Boolean).join('\n')
}

/** 记忆文件路径 */
export const memoryFileOf = (stateDir) => join(stateDir, 'memory.md')

export function readMemory(stateDir) {
  const file = memoryFileOf(stateDir)
  try {
    if (!existsSync(file)) return ''
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export function writeMemory(stateDir, text) {
  const file = memoryFileOf(stateDir)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, String(text ?? ''), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 一条记忆的默认书写方向(工具描述用,设置里能改) */
export const DEFAULT_REMEMBER_PROMPT =
  '记一条长期记忆 —— 只记「以后还用得上、而且不会自己过期的前提」:对方的账号、路径、习惯、约定、称呼、喜欢和不喜欢、机器怎么配、某件事的结论。' +
  '不要记一时的心情(那个走 mood_feel)、不要记这次对话里已经说完就完了的事。' +
  '一条只写一件事,写清楚到「几个月后看到还能懂」的程度,不要写「他」「刚才」这种指代。' +
  '同一件事已经记过就不要再记,系统会自动把时间刷新成现在。'
