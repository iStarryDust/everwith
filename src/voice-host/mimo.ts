/**
 * 小米 MiMo TTS 通道（OpenAI 兼容的 chat/completions 形态）。
 *
 * 接口要点（照官方文档）：
 *   POST https://api.xiaomimimo.com/v1/chat/completions
 *   header: api-key: <MIMO_API_KEY>
 *   body:   { model, messages[], audio: { format, voice } }
 *     - messages[assistant].content  ← 要朗读的正文（必须）
 *     - messages[user].content       ← 风格指令（自然语言，可选）
 *     - audio.voice                  ← 预置音色 ID，或克隆时的 data URL
 *   resp:   choices[0].message.audio.data = base64 音频
 *
 * 三个模型的分工：
 *   mimo-v2.5-tts             预置音色（8 个）
 *   mimo-v2.5-tts-voiceclone  传音频样本复刻（每次都带样本）
 *   mimo-v2.5-tts-voicedesign 纯文字描述造音色（本次不做，留接口位）
 */

export const MIMO_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions'

/** 预置音色（文档列出的 8 个）。 */
export const MIMO_PRESET_VOICES = [
  { id: 'mimo_default', name: 'MiMo 默认', lang: '自适应', gender: '' },
  { id: '冰糖', name: '冰糖', lang: '中文', gender: '女' },
  { id: '茉莉', name: '茉莉', lang: '中文', gender: '女' },
  { id: '苏打', name: '苏打', lang: '中文', gender: '男' },
  { id: '白桦', name: '白桦', lang: '中文', gender: '男' },
  { id: 'Mia', name: 'Mia', lang: '英文', gender: '女' },
  { id: 'Chloe', name: 'Chloe', lang: '英文', gender: '女' },
  { id: 'Milo', name: 'Milo', lang: '英文', gender: '男' },
  { id: 'Dean', name: 'Dean', lang: '英文', gender: '男' },
] as const

/** 默认风格指令（可在设置里改）。 */
export const MIMO_DEFAULT_STYLE = '少女音，语气温柔，自然语速，气声轻微'

/** 音频样本上限（文档：base64 后不超过 10MB）。 */
const MAX_SAMPLE_BASE64 = 10 * 1024 * 1024

/** 音频样本转成 data URL（voiceclone 用）。 */
export function toVoiceDataUrl(sample: Buffer, mime: 'audio/wav' | 'audio/mpeg'): string {
  const b64 = sample.toString('base64')
  if (b64.length > MAX_SAMPLE_BASE64) {
    throw new Error('音频样本过大：base64 后超过 10MB，请换更短的样本')
  }
  return `data:${mime};base64,${b64}`
}

/** 失败码 → 人话。 */
function explain(status: number, body: string): string {
  const brief = body.slice(0, 240)
  if (status === 401 || status === 403) return '小米 API Key 无效或没有该模型权限（HTTP ' + status + '）'
  if (status === 402 || /insufficient|balance|quota/i.test(brief)) return '小米账户额度不足'
  if (status === 429) return '小米接口请求过于频繁，请稍后再试'
  if (status === 400) return `小米接口拒绝了这次请求：${brief}`
  return `小米接口返回 HTTP ${status}：${brief}`
}

/**
 * 小米合成（非流式，一次性拿完整音频）。用作流式失败时的兜底。
 */
export async function synthesizeMimo(input: {
  apiKey: string
  text: string
  style: string
  voice: string
  clone?: boolean
  fmt?: 'wav' | 'pcm16'
  timeoutMs?: number
}): Promise<{ audio: Buffer; format: 'wav' | 'pcm16' }> {
  if (!input.apiKey) throw new Error('缺少小米 API Key')
  const text = input.text.trim()
  if (!text) throw new Error('没有要朗读的正文')

  const fmt = input.fmt ?? 'wav'
  const res = await postMimo(input, fmt, false)
  const json = await readJson(res)
  const b64 = pickAudioData(json)
  const audio = Buffer.from(b64, 'base64')
  if (audio.length < 200) throw new Error('小米返回了空音频')
  return { audio, format: fmt }
}

/* ─────────────────────────── 流式合成 ─────────────────────────── */

/** 流式回调。 */
export interface MimoStreamHandlers {
  /** 收到一段 PCM16（24kHz 单声道小端）。 */
  onChunk: (pcm: Buffer) => void
}

/**
 * 小米流式合成：SSE 边生成边推 `choices[0].delta.audio.data`（base64 PCM16）。
 *
 * 为什么能快：非流式要等整段合成完才返回（9 秒音频约 2.5 秒）；
 * 流式第一片通常在几百毫秒内到，可以立刻开始播。
 *
 * 注意：流式只支持 `pcm16`（文档：`stream: true` 时 format 默认即 pcm）。
 * @returns 完整 PCM（也用于写缓存）
 */
export async function streamMimo(
  input: {
    apiKey: string
    text: string
    style: string
    voice: string
    clone?: boolean
    timeoutMs?: number
    signal?: AbortSignal
  },
  handlers: MimoStreamHandlers,
): Promise<Buffer> {
  if (!input.apiKey) throw new Error('缺少小米 API Key')
  const text = input.text.trim()
  if (!text) throw new Error('没有要朗读的正文')

  const res = await postMimo(input, 'pcm16', true)
  if (!res.body) throw new Error('小米流式响应没有 body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const all: Buffer[] = []
  let buffer = ''
  let finished = false

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE：按行切，累积到 \n\n 为一条事件
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        idx = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue

        let j: any
        try {
          j = JSON.parse(payload)
        } catch {
          continue
        }

        const fr = j?.choices?.[0]?.finish_reason
        if (fr === 'content_filter') throw new Error('小米内容审核拦截了这段文本')

        const b64 = j?.choices?.[0]?.delta?.audio?.data
        if (typeof b64 === 'string' && b64.length > 0) {
          const pcm = Buffer.from(b64, 'base64')
          if (pcm.length > 0) {
            all.push(pcm)
            handlers.onChunk(pcm)
          }
        }
        if (fr) finished = true
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* ignore */ }
  }

  const pcm = Buffer.concat(all)
  if (pcm.length === 0) throw new Error(finished ? '小米没有返回音频' : '小米流式合成中断')
  return pcm
}

/* ─────────────────────────── 内部工具 ─────────────────────────── */

/** 构造并发送请求。 */
async function postMimo(
  input: { apiKey: string; text: string; style: string; voice: string; clone?: boolean; timeoutMs?: number; signal?: AbortSignal },
  fmt: 'wav' | 'pcm16',
  stream: boolean,
): Promise<Response> {
  const model = input.clone ? 'mimo-v2.5-tts-voiceclone' : 'mimo-v2.5-tts'

  // 正文必须是 assistant；风格指令放 user。
  // 没有风格时**不发送 user 消息**（只有在克隆模式下才发一条空的，
  // 因为克隆模型的 user 位置需要一个占位，否则服务端会拒绝）。
  const messages: Array<{ role: string; content: string }> = []
  const style = input.style.trim()
  if (style) messages.push({ role: 'user', content: style })
  else if (input.clone) messages.push({ role: 'user', content: '' })
  messages.push({ role: 'assistant', content: input.text.trim() })

  let res: Response
  try {
    res = await fetch(MIMO_ENDPOINT, {
      method: 'POST',
      headers: {
        'api-key': input.apiKey,
        'content-type': 'application/json',
        ...(stream ? { accept: 'text/event-stream' } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        audio: { format: fmt, voice: input.voice },
        stream,
      }),
      signal: input.signal ?? AbortSignal.timeout(input.timeoutMs ?? 120_000),
    })
  } catch (e) {
    const msg = (e as Error).message
    if (/timeout|abort/i.test(msg)) throw new Error('小米合成超时')
    throw new Error(`请求小米接口失败：${msg}`)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(explain(res.status, detail))
  }
  return res
}

/** 读 JSON 并把审核/空音频转成可读错误。 */
async function readJson(res: Response): Promise<any> {
  let json: any
  try {
    json = await res.json()
  } catch {
    throw new Error('小米接口返回的不是合法 JSON')
  }
  const fr = json?.choices?.[0]?.finish_reason
  if (fr === 'content_filter') throw new Error('小米内容审核拦截了这段文本')
  return json
}

/** 从响应里取 base64 音频，缺失时给出可读错误。 */
function pickAudioData(json: any): string {
  const b64 = json?.choices?.[0]?.message?.audio?.data
  if (typeof b64 !== 'string' || b64.length === 0) {
    throw new Error(`小米没有返回音频：${JSON.stringify(json).slice(0, 200)}`)
  }
  return b64
}
