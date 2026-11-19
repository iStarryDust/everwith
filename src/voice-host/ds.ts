/**
 * DeepSeek 官方开放 API 的语音合成通道。
 *
 * 只走**公开开放平台接口**（api.deepseek.com），不碰任何网页私有接口：
 *   POST /v1/tools/tts  { text, voice_id, format }
 *   鉴权：Authorization: Bearer <开放平台 API Key>
 *   返回：format=pcm 时为 24kHz / 16bit / 单声道裸 PCM
 *
 * 这条路正文由请求体直接给出，不需要把文本投递进会话、不需要浏览器、
 * 也不需要任何账号登录态 —— 因此不会在用户账号里留下任何痕迹。
 */

/** 采样率（各家 PCM 统一按 24kHz 处理）。 */
export const SAMPLE_RATE = 24000

/**
 * 从 wav 字节里抠出裸 PCM（跳过 RIFF 头）。
 * 有些接口会直接给完整 wav，统一成裸 PCM 才能一起走裁剪流程。
 */
export function wavToPcm(wav: Buffer): { pcm: Buffer; sampleRate: number } {
  if (wav.length > 44 && wav.toString('latin1', 0, 4) === 'RIFF') {
    let sampleRate = SAMPLE_RATE
    let offset = 12
    let dataStart = -1
    let dataLen = 0
    while (offset + 8 <= wav.length) {
      const id = wav.toString('latin1', offset, offset + 4)
      const size = wav.readUInt32LE(offset + 4)
      if (id === 'fmt ') sampleRate = wav.readUInt32LE(offset + 8)
      if (id === 'data') {
        dataStart = offset + 8
        dataLen = Math.min(size, wav.length - dataStart)
        break
      }
      offset += 8 + size + (size % 2)
    }
    if (dataStart >= 0) return { pcm: wav.subarray(dataStart, dataStart + dataLen), sampleRate }
  }
  return { pcm: wav, sampleRate: SAMPLE_RATE }
}

/** 开放平台可用的音色。 */
export const API_VOICES = [
  { id: 'stella', name: '海星（女）' },
  { id: 'tide', name: '暗潮（男）' },
] as const

/**
 * 文本 → PCM。
 * @param input.apiKey - 开放平台 API Key
 * @param input.text - 要朗读的正文（汉字按 2 个计费字符计）
 * @param input.voiceId - stella / tide
 * @returns 裸 PCM（24kHz / 16bit / 单声道）
 */
export async function synthesize(input: {
  apiKey: string
  text: string
  voiceId: string
  timeoutMs?: number
}): Promise<{ pcm: Buffer }> {
  if (!input.apiKey) throw new Error('缺少 API Key')
  const text = input.text.trim()
  if (!text) throw new Error('没有要朗读的正文')

  let res: Response
  try {
    res = await fetch('https://api.deepseek.com/v1/tools/tts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text,
        voice_id: input.voiceId || 'stella',
        format: 'pcm',
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
    })
  } catch (e) {
    const msg = (e as Error).message
    if (/timeout|abort/i.test(msg)) throw new Error('合成超时（网络或服务繁忙）')
    throw new Error(`请求官方 API 失败：${msg}`)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    const brief = detail.slice(0, 200)
    if (res.status === 401) throw new Error('API Key 无效或已失效（HTTP 401）')
    if (res.status === 402 || /insufficient|balance/i.test(brief)) throw new Error('账户余额不足（HTTP 402）')
    if (res.status === 429) throw new Error('请求过于频繁，请稍后再试（HTTP 429）')
    if (res.status === 400) throw new Error(`这段文本无法合成：${brief}`)
    throw new Error(`官方 API 返回 HTTP ${res.status}：${brief}`)
  }

  const pcm = Buffer.from(await res.arrayBuffer())
  if (pcm.length < 200) throw new Error('官方 API 返回了空音频')
  return { pcm }
}

/** 给裸 PCM 套 44 字节 WAV 头。 */
export function pcmToWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/**
 * 裁掉首尾静音。
 * 服务端会在开头推约 0.3 秒静音做缓冲，存成文件后听着会"慢半拍"。
 *
 * 性能：用 Int16Array 一次性映射整段 PCM，避免逐样本 readInt16LE
 * （9 秒音频约 21 万个采样点，逐次调用是大头）。
 * @returns 裁剪后的 PCM（前后各留 30ms）
 */
export function trimSilence(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const win = Math.floor(sampleRate * 0.005) // 5ms
  const total = Math.floor(pcm.length / 2)
  if (total < win * 4) return pcm

  // 一次性视图，零拷贝
  const view = new Int16Array(pcm.buffer, pcm.byteOffset, total)
  const frames = Math.floor(total / win)
  const thr = 30
  let first = -1
  let last = -1

  for (let f = 0; f < frames; f++) {
    const base = f * win
    let acc = 0
    for (let k = 0; k < win; k++) {
      const v = view[base + k]
      acc += v * v
    }
    // 阈值平方后比较，省掉每帧一次 sqrt
    if (acc / win > thr * thr) {
      if (first < 0) first = f
      last = f
    }
  }

  if (first < 0) return pcm
  const pad = Math.floor(sampleRate * 0.03)
  const start = Math.max(0, first * win - pad)
  const end = Math.min(total, (last + 1) * win + pad)
  return pcm.subarray(start * 2, end * 2)
}
