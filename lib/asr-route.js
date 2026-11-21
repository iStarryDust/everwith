/**
 * 语音识别的 HTTP 通道。
 *
 * 客户端录音 → 把 PCM 甩过来 → 这里识别 → 把文字还回去。
 *
 *   POST /api/everwith/asr/feed   { pcm: base64(float32) } → { streamId, text, endpoint }
 *   POST /api/everwith/asr/close  { streamId }             → { text }
 *   GET  /api/everwith/asr/status                          → { ready, dir, missing }
 *
 * 为什么是 base64 而不是 multipart：分片很小（100ms 的 16k float32 ≈ 6.4KB），
 * base64 多一点体积换代码简单，够用了。
 */
import { activeCount, close, feed, modelStatus, reset } from './asr.js'
import { guardRoute, makeRequestGate } from './guard.js'

const PREFIX = '/api/everwith/asr'

/** base64 → Float32Array */
function decodePcm(b64) {
  const buf = Buffer.from(String(b64 ?? ''), 'base64')
  // 必须按 4 字节对齐，否则下面读出来的数是错的
  const n = Math.floor(buf.length / 4)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4)
  return out
}

/**
 * 挂上三条路由。
 * @param ctx - 插件上下文
 * @param log - 日志函数（warn）
 * @returns 卸载函数
 */
export function applyAsrRoutes(ctx, log) {
  const webServer = ctx.webServer ?? ctx.get('webServer')
  /** 宿主那道访问检查：麦克风接口也不该让别的网页随便调 */
  const reject = makeRequestGate(ctx)
  if (!webServer?.register) {
    log?.('warn', 'webServer 不可用，语音识别接口未注册')
    return () => {}
  }

  const reply = (res, code, payload) => {
    try {
      res.statusCode = code
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(payload))
    } catch {
      /* ignore */
    }
  }

  const readJson = async (req) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    return raw ? JSON.parse(raw) : {}
  }

  const routes = [
    {
      method: 'GET',
      path: `${PREFIX}/status`,
      handler: async (_req, res) => {
        const st = modelStatus()
        reply(res, 200, { ok: true, ...st, streams: activeCount() })
      },
    },
    {
      method: 'POST',
      path: `${PREFIX}/feed`,
      handler: async (req, res) => {
        try {
          const body = await readJson(req)
          const pcm = decodePcm(body.pcm)
          if (!pcm.length) { reply(res, 400, { ok: false, error: '空音频' }); return }
          const rate = Number(body.rate) > 0 ? Number(body.rate) : 16000
          const r = feed(pcm, rate)
          reply(res, 200, { ok: true, ...r, rate })
        } catch (error) {
          reply(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      method: 'POST',
      path: `${PREFIX}/close`,
      handler: async (req, res) => {
        try {
          const body = await readJson(req)
          const r = close(String(body.streamId ?? ''))
          reply(res, 200, { ok: true, ...r })
        } catch (error) {
          reply(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      method: 'POST',
      path: `${PREFIX}/reset`,
      handler: async (_req, res) => {
        reset()
        reply(res, 200, { ok: true })
      },
    },
  ]

  const disposers = []
  for (const route of routes) {
    try {
      disposers.push(webServer.register(guardRoute(route, reject)))
    } catch (error) {
      log?.('warn', `语音识别路由 ${route.path} 注册失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return () => {
    for (const d of disposers) {
      try { d?.() } catch { /* ignore */ }
    }
  }
}
