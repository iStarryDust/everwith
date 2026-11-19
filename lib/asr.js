/**
 * 本地流式语音识别 —— 把麦克风的音频变成文字。
 *
 * 引擎：sherpa-onnx（zipformer2 中文 int8 量化模型，约 100 MB）。
 * 全部在本地跑，不联网、不花钱、不需要 key。
 *
 * 分两条路：
 *   feed  推一段 PCM 进来，返回"到目前为止听到的"整句
 *   close 句子说完了，返回最终文字并释放这条流
 *
 * 为什么要在宿主做而不是浏览器：sherpa-onnx 是原生模块，只有 Node 能加载。
 * 浏览器那边只负责录音和把 PCM 甩过来。
 */
import { createRequire } from 'node:module'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

/** 模型目录：跟情绪状态放一起，都是这台机器上的私货。 */
export function modelDir() {
  return join(homedir(), '.dsh', 'everwith', 'models', 'zh-streaming')
}

const NEEDED = ['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt']

/** 模型齐不齐。缺了就把缺的文件名告诉调用方，好提示用户下载。 */
export function modelStatus() {
  const dir = modelDir()
  const missing = NEEDED.filter((f) => !existsSync(join(dir, f)))
  return { ready: missing.length === 0, dir, missing }
}

let recognizer
/** 懒加载：第一次真正要用的时候才把模型读进内存（几百 MB，别没事就占着）。 */
function ensureRecognizer() {
  if (recognizer) return recognizer

  const status = modelStatus()
  if (!status.ready) {
    throw new Error(`识别模型没下载全，缺：${status.missing.join(', ')}（放到 ${status.dir}）`)
  }

  const { OnlineRecognizer } = require('sherpa-onnx-node')
  const dir = modelDir()

  recognizer = new OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(dir, 'encoder.int8.onnx'),
        decoder: join(dir, 'decoder.onnx'),
        joiner: join(dir, 'joiner.int8.onnx'),
      },
      tokens: join(dir, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: true,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
  })
  return recognizer
}

/** 每条录音流一个实例。 */
const streams = new Map()
let seq = 0

/** 最近一句话的落盘位置。识别不出时可以拿它当证据，直接听。 */
export function lastUtterancePath() {
  return join(homedir(), '.dsh', 'everwith', 'last-utterance.wav')
}

/**
 * 把 Float32 音频写成 16-bit PCM 的 wav。
 * 只用来事后确认"到底录到了什么"，识别链路不依赖它。
 */
function writeWav(samples, rate) {
  const p = lastUtterancePath()
  try {
    const n = samples.length
    const head = Buffer.alloc(44)
    head.write('RIFF', 0, 'ascii')
    head.writeUInt32LE(36 + n * 2, 4)
    head.write('WAVE', 8, 'ascii')
    head.write('fmt ', 12, 'ascii')
    head.writeUInt32LE(16, 16)
    head.writeUInt16LE(1, 20) // PCM
    head.writeUInt16LE(1, 22) // 单声道
    head.writeUInt32LE(rate, 24)
    head.writeUInt32LE(rate * 2, 28)
    head.writeUInt16LE(2, 32)
    head.writeUInt16LE(16, 34)
    head.write('data', 36, 'ascii')
    head.writeUInt32LE(n * 2, 40)

    const body = Buffer.alloc(n * 2)
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]))
      body.writeInt16LE(Math.round(v * 32767), i * 2)
    }
    writeFileSync(p, Buffer.concat([head, body]))
    return p
  } catch {
    return ''
  }
}

/**
 * 推一段音频。
 * @param pcm - Float32Array，取值 -1~1
 * @param rate - 这段音频的采样率。麦常见 48k，模型要 16k，
 *               **交给 sherpa 自己重采样** —— 手写线性插值会引入失真，
 *               实测手写版本识别不出一个字，交回去就好了。
 * @returns { streamId, text, endpoint, level, samples }
 */
/** 最后一次收到音频的时间。通话状态就从这里推断，不依赖客户端另外通知。 */
let lastFeedAt = 0

/** 多久没收到音频就算挂了（ms） */
export const VOICE_IDLE_MS = 6000

/** 现在是不是在通话：最近 VOICE_IDLE_MS 内收到过音频。 */
export function isVoiceActive() {
  return Date.now() - lastFeedAt < VOICE_IDLE_MS
}

// ── 通话开关 ────────────────────────────────────────────────────────────────
// 放在这一层,是为了让语音模块(它拿不到 plugin 的闭包)也能判断"在不在通话里"。

/** 客户端点过通话的总开关（全局） */
let callGlobal = false
/** 单独标过在通话的会话 */
const callSessions = new Set()

export function setCallGlobal(on) {
  callGlobal = Boolean(on)
}

export function markCallSession(id, on) {
  const key = String(id ?? '')
  if (!key) return
  if (on) callSessions.add(key)
  else callSessions.delete(key)
}

/**
 * 这个会话现在算不算在通话。
 * **只认客户端那把开关** —— 点了通话才算,点挂断就不算。
 * 音频活动不参与判断:录音可能在页面一打开就在跑,拿它当证据会把普通聊天误判成通话。
 */
export function isCallActive(sessionId) {
  if (callGlobal) return true
  return Boolean(sessionId && callSessions.has(String(sessionId)))
}

export function feed(pcm, rate = 16000) {
  lastFeedAt = Date.now()
  const rec = ensureRecognizer()
  let id = null

  // 没给 id 就新开一条
  for (const [k, v] of streams) {
    if (v.open) { id = k; break }
  }
  if (!id) {
    id = 'asr-' + ++seq
    streams.set(id, { stream: rec.createStream(), open: true, text: '', pcm: [], rate })
  }

  const slot = streams.get(id)
  if (!slot) throw new Error('识别流丢了')

  // 留一份原始音频，识别不出的时候能拿出来看
  if (slot.pcm.length < 400) slot.pcm.push(new Float32Array(pcm))
  slot.rate = rate

  slot.stream.acceptWaveform({ sampleRate: rate, samples: pcm })
  while (rec.isReady(slot.stream)) rec.decode(slot.stream)

  const result = rec.getResult(slot.stream)
  const text = String(result?.text ?? '')
  if (text) slot.text = text

  // 顺带把音量回给客户端：没声音还是听不出字，一眼就能分
  let sum = 0
  for (let i = 0; i < pcm.length; i += 4) sum += pcm[i] * pcm[i]
  const level = Math.sqrt(sum / Math.max(1, pcm.length / 4))

  return {
    streamId: id,
    text: slot.text,
    endpoint: Boolean(result?.isEndpoint),
    level: Number(level.toFixed(4)),
    samples: pcm.length,
  }
}

/** 结束一条流，返回最终文字并清理。顺带把这句话的录音存成 wav。 */
export function close(streamId) {
  const slot = streams.get(streamId)
  if (!slot) return { streamId, text: '' }
  if (!slot.pcm?.length && !slot.text) {
    streams.delete(streamId)
    return { streamId, text: '' }
  }
  try {
    const rec = ensureRecognizer()
    while (rec.isReady(slot.stream)) rec.decode(slot.stream)
    const text = String(rec.getResult(slot.stream)?.text ?? '') || slot.text

    // 落一份 wav：识别不出时能直接听是什么味道
    let wav = ''
    const parts = slot.pcm ?? []
    if (parts.length) {
      const total = parts.reduce((n, a) => n + a.length, 0)
      const all = new Float32Array(total)
      let off = 0
      for (const a of parts) { all.set(a, off); off += a.length }
      wav = writeWav(all, slot.rate)
    }

    streams.delete(streamId)
    return { streamId, text, wav, samples: parts.reduce((n, a) => n + a.length, 0) }
  } catch {
    streams.delete(streamId)
    return { streamId, text: slot.text }
  }
}

/** 丢掉所有进行中的流（挂断、切会话时用）。 */
export function reset() {
  streams.clear()
}

/** 当前有几条流。 */
export function activeCount() {
  return streams.size
}
