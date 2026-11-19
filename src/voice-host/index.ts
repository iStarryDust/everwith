/**
 * companion-voice — 宿主半。
 *
 * 两个引擎，设置里切换：
 *   deepseek  官方开放 API（api.deepseek.com/v1/tools/tts）
 *   mimo      小米 MiMo TTS（api.xiaomimimo.com/v1/chat/completions），支持预置音色与样本克隆
 *
 * 共同点：都是官方公开接口，只需要用户自己的 API Key；
 * 不驱动浏览器、不调用网页私有接口、不往任何账号里投递消息。
 *
 * 速度策略：
 *   1) 内容哈希缓存 —— 同一句话第二次点播直接命中，零等待零费用
 *   2) 小米走 SSE 流式 —— 首包约 0.9 秒就开始播，不必等整段合成完
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  cacheKey,
  cacheStats,
  clearCache,
  initCache,
  lookupCache,
  pruneCache,
  writeCache,
} from './cache.ts'
import { API_VOICES, pcmToWav, synthesize, trimSilence } from './ds.ts'
import { MIMO_DEFAULT_STYLE, MIMO_PRESET_VOICES, streamMimo, synthesizeMimo, toVoiceDataUrl } from './mimo.ts'
import { mimoSpeechGuidance } from './speech-prompt.ts'

/** 稳定插件名。 */
export const name = 'companion-voice'

/** 必需服务：Web 服务器 + 系统提示词注册表。 */
export const inject = ['webServer', 'systemPrompt']

/**
 * 通话探针：由情绪那一侧注入，判断「现在算不算在通话」。
 * 默认 true —— 单独装语音模块时不改变原有行为；和 spoon-companion 一起用时，
 * 语音播报格式只在通话中才注入，平时不写一堆标签规则干扰聊天。
 */
let callProbe: () => boolean = () => true
export function setCallProbe(fn: () => boolean): void {
  callProbe = typeof fn === 'function' ? fn : () => true
}

const PREFIX = '/api/companion-voice'

/** 采样率（各家 PCM 统一按 24kHz）。 */
const SR = 24000

/** 引擎标识。 */
type Engine = 'deepseek' | 'mimo'

/** 落盘配置。 */
interface CvConfig {
  /** 全局启用开关。 */
  enabled: boolean
  /** 自动朗读新回复。 */
  autoPlay: boolean
  engine: Engine
  deepseekKey: string
  deepseekVoice: string
  mimoKey: string
  mimoVoice: string
  mimoStyle: string
  mimoUseClone: boolean
  mimoSample: string
}

/** 运行时状态。 */
interface CvState {
  lastError: string
}

/** 数据目录。 */
function home(): string {
  const dir = join(homedir(), '.dsh', 'companion-voice')
  mkdirSync(join(dir, 'audio'), { recursive: true })
  mkdirSync(join(dir, 'samples'), { recursive: true })
  return dir
}

/** 读 JSON 文件并剥掉 UTF-8 BOM。 */
function readJsonFile<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T
  } catch {
    return undefined
  }
}

/** 读配置。 */
function readConfig(): CvConfig {
  const fallback: CvConfig = {
    enabled: true,
    autoPlay: false,
    engine: 'deepseek',
    deepseekKey: '',
    deepseekVoice: 'stella',
    mimoKey: '',
    mimoVoice: '冰糖',
    mimoStyle: MIMO_DEFAULT_STYLE,
    mimoUseClone: false,
    mimoSample: '',
  }
  const parsed = readJsonFile<Partial<CvConfig>>(join(home(), 'config.json'))
  return parsed ? { ...fallback, ...parsed } : fallback
}

/** 写配置。 */
function writeConfig(patch: Partial<CvConfig>): CvConfig {
  const next = { ...readConfig(), ...patch }
  writeFileSync(join(home(), 'config.json'), JSON.stringify(next, null, 2), 'utf8')
  return next
}

/** 是否来自本机回环。 */
function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** 回 JSON。 */
function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/** 读请求体（限 1MB）。 */
async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > 1024 * 1024) throw new Error('请求体过大')
    chunks.push(chunk as Buffer)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 读上传的音频样本（限 12MB）。 */
async function readBinary(req: IncomingMessage, limit = 12 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > limit) throw new Error('样本文件过大（上限 12MB）')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** 一次合成的上下文（决定缓存 key 与实际调用参数）。 */
interface SynthPlan {
  engine: Engine
  voice: string
  style: string
  clone: boolean
}

/** 由配置推导这次的合成参数。 */
function planOf(cfg: CvConfig): SynthPlan {
  if (cfg.engine === 'mimo') {
    let voice = cfg.mimoVoice
    let clone = false
    if (cfg.mimoUseClone) {
      if (!cfg.mimoSample) throw new Error('已选择克隆模式，但还没有上传音频样本')
      const samplePath = join(home(), 'samples', cfg.mimoSample)
      if (!existsSync(samplePath)) throw new Error('音频样本文件不见了，请重新上传')
      const sample = readFileSync(samplePath)
      const mime = cfg.mimoSample.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav'
      voice = toVoiceDataUrl(sample, mime)
      clone = true
    }
    return { engine: 'mimo', voice, style: cfg.mimoStyle, clone }
  }
  return { engine: 'deepseek', voice: cfg.deepseekVoice, style: '', clone: false }
}

/** 缓存 key 里用可读的音色标识（克隆时不把整个 base64 塞进去）。 */
function cacheVoiceLabel(cfg: CvConfig, plan: SynthPlan): string {
  if (plan.engine === 'mimo' && plan.clone) return `clone:${cfg.mimoSample}`
  return plan.voice
}

/**
 * 装配插件。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx: Context): void {
  const state: CvState = { lastError: '' }
  initCache(join(home(), 'audio'))

  // 启动时回收一次（异步，不阻塞加载）
  ctx.effect(() => {
    const timer = setTimeout(() => {
      try {
        const n = pruneCache()
        if (n > 0) console.log(`[companion-voice] 缓存回收 ${n} 个文件`)
      } catch { /* ignore */ }
    }, 3000)
    return () => clearTimeout(timer)
  }, 'companion-voice: cache prune')

  // 语音输出格式提示：切到小米时告诉模型该怎么写台词
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'companion-voice:speech-format',
        order: 3000,
        text: () => {
          const cfg = readConfig()
          if (cfg.engine !== 'mimo') return ''
          if (!callProbe()) return ''
          return mimoSpeechGuidance(cfg.mimoStyle)
        },
      }),
    'companion-voice: speech format prompt',
  )

  const routes: WebRoute[] = [
    // 状态
    {
      method: 'GET',
      path: `${PREFIX}/state`,
      handler: async (_req, res) => {
        const cfg = readConfig()
        const stats = cacheStats()
        json(res, 200, {
          ok: true,
          enabled: cfg.enabled,
          autoPlay: cfg.autoPlay,
          engine: cfg.engine,
          deepseek: {
            hasKey: cfg.deepseekKey.length > 0,
            keyTail: cfg.deepseekKey ? cfg.deepseekKey.slice(-4) : '',
            voice: cfg.deepseekVoice,
            voices: API_VOICES.map((v) => ({ id: v.id, name: v.name })),
          },
          mimo: {
            hasKey: cfg.mimoKey.length > 0,
            keyTail: cfg.mimoKey ? cfg.mimoKey.slice(-4) : '',
            voice: cfg.mimoVoice,
            voices: MIMO_PRESET_VOICES.map((v) => ({
              id: v.id,
              name: v.gender ? `${v.name}（${v.lang}·${v.gender}）` : `${v.name}（${v.lang}）`,
            })),
            style: cfg.mimoStyle,
            defaultStyle: MIMO_DEFAULT_STYLE,
            useClone: cfg.mimoUseClone,
            sample: cfg.mimoSample,
            hasSample: Boolean(cfg.mimoSample && existsSync(join(home(), 'samples', cfg.mimoSample))),
          },
          cache: { bytes: stats.bytes, count: stats.count },
          lastError: state.lastError,
          home: home(),
        })
      },
    },
    // 改配置
    {
      method: 'POST',
      path: `${PREFIX}/config`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return json(res, 403, { ok: false, error: '仅限本机' })
        const body = await readBody(req).catch(() => ({}))
        const patch: Partial<CvConfig> = {}
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
        if (typeof body.autoPlay === 'boolean') patch.autoPlay = body.autoPlay
        if (body.engine === 'deepseek' || body.engine === 'mimo') patch.engine = body.engine
        if (typeof body.deepseekKey === 'string') patch.deepseekKey = body.deepseekKey.trim()
        if (typeof body.mimoKey === 'string') patch.mimoKey = body.mimoKey.trim()
        if (typeof body.mimoStyle === 'string') patch.mimoStyle = body.mimoStyle
        if (typeof body.mimoUseClone === 'boolean') patch.mimoUseClone = body.mimoUseClone
        if (typeof body.deepseekVoice === 'string') {
          if (!API_VOICES.some((v) => v.id === body.deepseekVoice)) {
            return json(res, 400, { ok: false, error: `不支持的 DeepSeek 音色：${body.deepseekVoice}` })
          }
          patch.deepseekVoice = body.deepseekVoice
        }
        if (typeof body.mimoVoice === 'string') {
          if (!MIMO_PRESET_VOICES.some((v) => v.id === body.mimoVoice)) {
            return json(res, 400, { ok: false, error: `不支持的小米音色：${body.mimoVoice}` })
          }
          patch.mimoVoice = body.mimoVoice
        }
        writeConfig(patch)
        json(res, 200, { ok: true })
      },
    },
    // 清空缓存
    {
      method: 'POST',
      path: `${PREFIX}/cache/clear`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return json(res, 403, { ok: false, error: '仅限本机' })
        const before = cacheStats()
        const r = clearCache()
        json(res, 200, { ok: true, removed: r.removed, freedBytes: before.bytes })
      },
    },
    // 上传克隆样本
    {
      method: 'POST',
      path: `${PREFIX}/sample`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return json(res, 403, { ok: false, error: '仅限本机' })
        const ct = String(req.headers['content-type'] ?? '')
        const isMp3 = /mpeg|mp3/i.test(ct)
        const isWav = /wav|x-wave/i.test(ct)
        if (!isMp3 && !isWav) return json(res, 400, { ok: false, error: '只支持 wav / mp3 样本' })

        let buf: Buffer
        try {
          buf = await readBinary(req)
        } catch (e) {
          return json(res, 400, { ok: false, error: (e as Error).message })
        }
        if (buf.length < 1000) return json(res, 400, { ok: false, error: '样本太小，至少需要 1 秒清晰人声' })

        const ext = isMp3 ? 'mp3' : 'wav'
        const fileName = `voice-${Date.now()}.${ext}`
        writeFileSync(join(home(), 'samples', fileName), buf)
        const old = readConfig().mimoSample
        if (old && old !== fileName) {
          const p = join(home(), 'samples', old)
          if (existsSync(p)) {
            try { rmSync(p) } catch { /* ignore */ }
          }
        }
        writeConfig({ mimoSample: fileName, mimoUseClone: true })
        json(res, 200, { ok: true, sample: fileName, bytes: buf.length, format: ext })
      },
    },
    // 删除克隆样本（独立路径：WebServer 不允许重复 path）
    {
      method: 'POST',
      path: `${PREFIX}/sample/clear`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return json(res, 403, { ok: false, error: '仅限本机' })
        const cfg = readConfig()
        if (cfg.mimoSample) {
          const p = join(home(), 'samples', cfg.mimoSample)
          if (existsSync(p)) {
            try { rmSync(p) } catch { /* ignore */ }
          }
        }
        writeConfig({ mimoSample: '', mimoUseClone: false })
        json(res, 200, { ok: true })
      },
    },
    // 合成（非流式）：命中缓存立刻返回，未命中则合成后落缓存
    {
      method: 'POST',
      path: `${PREFIX}/speak`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return json(res, 403, { ok: false, error: '仅限本机' })
        const t0 = Date.now()
        const body = await readBody(req).catch(() => ({}))
        const text = String(body.text ?? '').trim()
        if (!text) return json(res, 400, { ok: false, error: '没有要朗读的正文' })

        const cfg = readConfig()
        if (!cfg.enabled) return json(res, 409, { ok: false, error: '陪伴语音已关闭（可在设置里启用）' })

        try {
          const plan = planOf(cfg)
          const key = cacheKey({
            engine: plan.engine,
            voice: cacheVoiceLabel(cfg, plan),
            style: plan.style,
            text,
          })

          // ① 缓存命中：直接返回，零等待零费用
          const hit = lookupCache(key)
          if (hit) {
            const bytes = readFileSync(hit)
            return json(res, 200, {
              ok: true,
              url: `${PREFIX}/audio?id=${key}`,
              spoken: text,
              engine: plan.engine,
              voice: plan.voice === cfg.mimoVoice ? cfg.mimoVoice : cfg.deepseekVoice,
              bytes: bytes.length,
              seconds: Number(((bytes.length - 44) / 2 / SR).toFixed(2)),
              ms: Date.now() - t0,
              cached: true,
            })
          }

          // ② 未命中：合成
          let wav: Buffer
          let seconds: number
          if (plan.engine === 'mimo') {
            if (!cfg.mimoKey) throw new Error('请先在插件设置里填小米 API Key')
            const out = await synthesizeMimo({
              apiKey: cfg.mimoKey,
              text,
              style: plan.style,
              voice: plan.voice,
              clone: plan.clone,
              fmt: 'pcm16',
            })
            wav = pcmToWav(trimSilence(out.audio))
            seconds = Number((out.audio.length / 2 / SR).toFixed(2))
          } else {
            if (!cfg.deepseekKey) throw new Error('请先在插件设置里填 DeepSeek API Key')
            const out = await synthesize({ apiKey: cfg.deepseekKey, text, voiceId: plan.voice })
            wav = pcmToWav(trimSilence(out.pcm))
            seconds = Number((out.pcm.length / 2 / SR).toFixed(2))
          }

          writeCache(key, wav)
          state.lastError = ''
          json(res, 200, {
            ok: true,
            url: `${PREFIX}/audio?id=${key}`,
            spoken: text,
            engine: plan.engine,
            voice: plan.clone ? `克隆（${cfg.mimoSample}）` : plan.voice,
            bytes: wav.length,
            seconds,
            ms: Date.now() - t0,
            cached: false,
          })
        } catch (e) {
          const error = (e as Error).message
          state.lastError = error
          json(res, 500, { ok: false, error })
        }
      },
    },
    // 合成（流式）：SSE 推 PCM16 分片，前端边收边播
    {
      method: 'POST',
      path: `${PREFIX}/speak-stream`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return json(res, 403, { ok: false, error: '仅限本机' })
        const t0 = Date.now()
        const body = await readBody(req).catch(() => ({}))
        const text = String(body.text ?? '').trim()
        if (!text) return json(res, 400, { ok: false, error: '没有要朗读的正文' })

        const cfg = readConfig()
        if (!cfg.enabled) return json(res, 409, { ok: false, error: '陪伴语音已关闭（可在设置里启用）' })
        if (cfg.engine !== 'mimo') {
          return json(res, 409, { ok: false, error: '流式仅支持小米引擎', fallback: true })
        }
        if (!cfg.mimoKey) return json(res, 400, { ok: false, error: '请先在插件设置里填小米 API Key' })

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })

        /** 推一条 SSE 事件。 */
        const push = (event: string, data: unknown): void => {
          try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          } catch { /* 客户端已断开 */ }
        }

        try {
          const plan = planOf(cfg)
          const key = cacheKey({
            engine: plan.engine,
            voice: cacheVoiceLabel(cfg, plan),
            style: plan.style,
            text,
          })

          // 缓存命中：整段一次性推完（前端立即播放）。
          // 注意 url 和 cached:true 必须在**同一个事件**里 ——
          // 前端靠「既有一 url 又有 cached:true」来识别这条件，拆开两个事件会两边都不匹配。
          const hit = lookupCache(key)
          if (hit) {
            const wav = readFileSync(hit)
            push('done', {
              ok: true,
              cached: true,
              url: `${PREFIX}/audio?id=${key}`,
              bytes: wav.length,
              ms: Date.now() - t0,
            })
            return res.end()
          }

          push('start', { engine: plan.engine, voice: plan.clone ? '克隆音色' : cfg.mimoVoice })

          const pieces: Buffer[] = []
          let firstAt = 0
          const pcm = await streamMimo(
            {
              apiKey: cfg.mimoKey,
              text,
              style: plan.style,
              voice: plan.voice,
              clone: plan.clone,
            },
            {
              onChunk: (chunk) => {
                if (firstAt === 0) firstAt = Date.now() - t0
                pieces.push(chunk)
                // 分片转 base64 单发，前端按顺序排程播放
                push('chunk', { pcm: chunk.toString('base64'), seq: pieces.length })
              },
            },
          )

          // 全部收完：落缓存（用统一裁剪后的成品 wav）
          const wav = pcmToWav(trimSilence(pcm))
          writeCache(key, wav)

          push('done', {
            ok: true,
            cached: false,
            firstMs: firstAt,
            totalMs: Date.now() - t0,
            seconds: Number((pcm.length / 2 / SR).toFixed(2)),
            url: `${PREFIX}/audio?id=${key}`,
          })
          res.end()
        } catch (e) {
          const error = (e as Error).message
          state.lastError = error
          push('error', { ok: false, error })
          try { res.end() } catch { /* ignore */ }
        }
      },
    },
    // 取音频
    {
      method: 'GET',
      path: `${PREFIX}/audio`,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '', 'http://127.0.0.1')
        const id = url.searchParams.get('id') ?? ''
        if (!/^[0-9a-f]{16}$/.test(id)) return json(res, 400, { ok: false, error: 'bad id' })
        // 用 lookupCache 拿路径（顺带刷新访问时间，让 LRU 认为它刚用过）
        const file = lookupCache(id)
        if (!file) return json(res, 404, { ok: false, error: '音频不存在' })
        const buf = readFileSync(file)
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': String(buf.length),
          'cache-control': 'public, max-age=31536000, immutable',
        })
        res.end(buf)
      },
    },
  ]

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    for (const route of routes) {
      try {
        disposers.push(ctx.webServer.register(route))
      } catch (e) {
        // 单条注册失败（例如路径重复）不能拖累其余路由，否则后面全部静默丢失
        console.error(`[companion-voice] 路由 ${route.method} ${route.path} 注册失败：${(e as Error).message}`)
      }
    }
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'companion-voice: http routes')

  console.log(`[companion-voice] 已就绪（DeepSeek / MiMo，含缓存与流式） · 数据目录 ${home()}`)
}
