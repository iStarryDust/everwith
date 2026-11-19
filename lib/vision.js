/**
 * 把一张截图交给视觉模型,换回一句话。
 *
 * 只在「值得看」的时候调用 —— 窗口换了、标题里出现报错,或者设成了 always。
 * 平时截图不进模型,这是刻意的:图比文字贵三个数量级。
 *
 * 图片必须先存进宿主的附件库拿到 ref,再以 `{ type: 'image', attachment: ref }`
 * 的形式放进消息 —— 直接塞 base64 会被传输层拒掉。
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

/** 描述指令:短、只写做的事、不抄内容。 */
export const DESCRIBE_INSTRUCTION = [
  '看看这张屏幕截图,用一句中文说明「屏幕上的人在做什么」。',
  '要求:',
  '- 一句话,不超过 30 个字,不要标点堆砌',
  '- 只说在做什么(写代码 / 看视频 / 打游戏 / 聊天 / 看文档),能看出具体事就点一句',
  '- 不抄屏幕上的文字、代码、文件名、人名、账号',
  '- 看不出是哪件事就说个大类,例如「在看网页」「在桌面上」',
  '- 只输出这一句话,不要前言、不要引号',
].join('\n')

/** 扩展名 → MIME */
export function mimeOf(path) {
  const p = String(path ?? '').toLowerCase()
  if (p.endsWith('.png')) return 'image/png'
  if (p.endsWith('.webp')) return 'image/webp'
  if (p.endsWith('.gif')) return 'image/gif'
  return 'image/jpeg'
}

/** 把模型输出洗成一句话:去引号、去换行、去前缀、截断。 */
export function cleanDescription(output) {
  let text = String(output ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .trim()
  text = text.replace(/^(这张图(片)?(显示|是)?[::]?\s*|屏幕(上|里)(显示|是)?[::]?\s*|图(中|里)[::]?\s*)/, '')
  text = text.replace(/^[「『"']+|[」』"']+$/g, '').trim()
  text = text.replace(/\s+/g, ' ')
  if (text.length > 40) text = `${text.slice(0, 40)}…`
  return text
}

/**
 * 让视觉模型看一眼这张图。
 *
 * @param {object} opts
 * @param {any} opts.llm - 宿主的 llm 服务(要有 stream)
 * @param {any} opts.attachments - 宿主的附件库(要有 saveImage)
 * @param {object} opts.callConfig - 当前会话的模型配置
 * @param {string} opts.sessionId - 会话 id
 * @param {string} opts.imagePath - 截图路径
 * @param {string} [opts.title] - 窗口标题,给模型一点上下文
 * @returns {Promise<string>} 一句话;失败就抛错(调用方记审计)
 */
export async function describeShot({ llm, attachments, callConfig, sessionId, imagePath, title }) {
  if (!llm?.stream) throw new Error('vision-no-llm')
  if (!callConfig) throw new Error('vision-no-callconfig')
  if (!attachments?.saveImage) throw new Error('vision-no-attachments')

  let bytes
  try {
    bytes = readFileSync(imagePath)
  } catch (error) {
    throw new Error(`vision-read-failed:${error?.message ?? error}`)
  }

  // 先存进宿主附件库,拿到引用
  let ref
  try {
    ref = await attachments.saveImage({
      data: bytes,
      mediaType: mimeOf(imagePath),
      name: basename(String(imagePath)),
    })
  } catch (error) {
    throw new Error(`vision-save-failed:${String(error?.message ?? error).slice(0, 120)}`)
  }

  const hint = title ? `窗口标题:${String(title).slice(0, 80)}\n\n` : ''
  const message = {
    id: crypto.randomUUID(),
    role: 'user',
    content: [
      { type: 'text', text: hint + DESCRIBE_INSTRUCTION },
      { type: 'image', attachment: ref },
    ],
    source: { kind: 'user' },
  }

  let output = ''
  const kinds = new Map()
  let tail = ''
  for await (const chunk of llm.stream({ ...callConfig, messages: [message], sessionId })) {
    const kind = String(chunk?.type ?? 'none')
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
    if (kind !== 'text-delta') {
      try {
        const reason = chunk?.reason ?? chunk?.finishReason ?? chunk?.error
        const failure = reason?.failure?.message ?? reason?.message ?? (typeof reason === 'string' ? reason : '')
        tail = failure ? String(failure).slice(0, 300) : JSON.stringify(chunk).slice(0, 200)
      } catch { tail = kind }
    }
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text
  }

  const cleaned = cleanDescription(output)
  if (!cleaned) {
    const seen = [...kinds.entries()].map(([k, n]) => `${k}x${n}`).join(',') || 'no-chunks'
    throw new Error(`vision-empty chunks=[${seen}]${tail ? ' fin=' + tail : ''}`)
  }
  return cleaned
}
