/**
 * 宿主路由的 fetch 封装（浏览器半）。一律同源相对路径。
 */
const PREFIX = '/api/companion-voice'

/**
 * 播放去重（替代早期的"互斥锁"）。
 *
 * 早期用 playingLock 做互斥，但任何一条释放路径漏掉都会导致锁永久卡住，
 * 表现为"播一次之后怎么点都没声"。改成**时间窗去重**：
 * 同一个 key 在 DEDUPE_MS 内只允许发起一次，窗口一过自动失效。
 *
 * 这样即使某次播放异常退出，最多影响 1.5 秒，不会永久卡死。
 */
const DEDUPE_MS = 1500
let lastStartKey = ''
let lastStartAt = 0

/** 判断这次启动是否应该被丢弃（窗口内的重复请求）。 */
function shouldDrop(key: string): boolean {
  const now = Date.now()
  if (key === lastStartKey && now - lastStartAt < DEDUPE_MS) return true
  lastStartKey = key
  lastStartAt = now
  return false
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`companion-voice 返回了非 JSON（HTTP ${res.status}）`)
  }
}

/** 引擎。 */
export type CvEngine = 'deepseek' | 'mimo'

/** 状态。 */
export interface CvStateView {
  ok: boolean
  enabled: boolean
  autoPlay: boolean
  engine: CvEngine
  deepseek: {
    hasKey: boolean
    keyTail: string
    voice: string
    voices: Array<{ id: string; name: string }>
  }
  mimo: {
    hasKey: boolean
    keyTail: string
    voice: string
    voices: Array<{ id: string; name: string }>
    style: string
    defaultStyle: string
    useClone: boolean
    sample: string
    hasSample: boolean
  }
  lastError: string
  home: string
  cache: { bytes: number; count: number }
}

/** 合成结果。 */
export interface CvSpeakResult {
  ok: boolean
  url?: string
  spoken?: string
  engine?: string
  voice?: string
  seconds?: number
  ms?: number
  cached?: boolean
  error?: string
}

/** 缓存占用。 */
export interface CvCacheStats {
  bytes: number
  count: number
}

export const api = {
  state: () => jsonFetch<CvStateView>(`${PREFIX}/state`),
  config: (patch: Record<string, unknown>) =>
    jsonFetch<{ ok: boolean; error?: string }>(`${PREFIX}/config`, { method: 'POST', body: JSON.stringify(patch) }),
  speak: (text: string) => jsonFetch<CvSpeakResult>(`${PREFIX}/speak`, { method: 'POST', body: JSON.stringify({ text }) }),
  clearCache: () =>
    jsonFetch<{ ok: boolean; removed: number; freedBytes: number }>(`${PREFIX}/cache/clear`, { method: 'POST', body: '{}' }),

  /** 上传克隆样本（原始二进制）。 */
  uploadSample: async (file: File): Promise<{ ok: boolean; sample?: string; error?: string }> => {
    const res = await fetch(`${PREFIX}/sample`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'audio/wav' },
      body: file,
    })
    return (await res.json()) as { ok: boolean; sample?: string; error?: string }
  },

  /** 删除样本（同时关掉克隆）。 */
  clearSample: () => jsonFetch<{ ok: boolean }>(`${PREFIX}/sample/clear`, { method: 'POST', body: '{}' }),
}

/** 当前正在播的音频。 */
let currentAudio: HTMLAudioElement | undefined

/** 播放状态广播（供全局播放条订阅）。 */
export interface PlaybackState {
  /** 是否正在播。 */
  playing: boolean
  /** 正在播哪条消息（用于在按钮上高亮）。 */
  messageId: string
  /** 正在播的正文前若干字（播放条上显示）。 */
  label: string
}

let playback: PlaybackState = { playing: false, messageId: '', label: '' }
const playbackListeners = new Set<() => void>()

function setPlayback(next: Partial<PlaybackState>): void {
  playback = { ...playback, ...next }
  for (const fn of playbackListeners) fn()
}

/** 读当前播放状态。 */
export function getPlayback(): PlaybackState {
  return playback
}

/** 订阅播放状态。 */
export function subscribePlayback(fn: () => void): () => void {
  playbackListeners.add(fn)
  return () => {
    playbackListeners.delete(fn)
  }
}

/**
 * 播放一段音频 URL。
 * @param url - 音频地址
 * @param meta - 用于播放条展示与按钮高亮
 */
export function playAudio(url: string, meta?: { messageId?: string; label?: string }): void {
  stopAudio()
  const audio = new Audio(url)
  currentAudio = audio
  setPlayback({
    playing: true,
    messageId: meta?.messageId ?? '',
    label: (meta?.label ?? '').replace(/\s+/g, ' ').slice(0, 40),
  })
  audio.addEventListener('ended', () => {
    // 只有"还是当前这个 audio"才是真正播完；被替换掉的旧实例不能碰锁
    if (currentAudio !== audio) return
    currentAudio = undefined
    setPlayback({ playing: false, messageId: '', label: '' })
  })
  audio.addEventListener('error', () => {
    if (currentAudio !== audio) return
    currentAudio = undefined
    setPlayback({ playing: false, messageId: '', label: '' })
  })
  void audio.play().catch(() => {
    /* 点按钮本身就是用户手势，一般不会走到这 */
  })
}

/** 停止播放（全局，任何地方都能调）。 */
export function stopAudio(): void {
  const had = currentAudio !== undefined
  if (currentAudio) {
    try {
      currentAudio.pause()
      currentAudio.currentTime = 0
    } catch {
      /* ignore */
    }
    currentAudio = undefined
  }
  if (had || playback.playing) setPlayback({ playing: false, messageId: '', label: '' })
}

/** 是否正在播。 */
export function isPlaying(): boolean {
  return currentAudio !== undefined && !currentAudio.paused
}

/* ────────────────────────── 流式播放器 ────────────────────────── */

/** 采样率（与宿主约定一致）。 */
const STREAM_SR = 24000

/** 流式播放状态。 */
interface StreamState {
  ctx: AudioContext
  /** 下一段的排程时间点。 */
  nextTime: number
  /** 已排程但尚未播完的 source。 */
  sources: Set<AudioBufferSourceNode>
  /** 中止网络读取。 */
  abort: AbortController
  /** 标记：是否已经收到首片（用于"开始播放"回调）。 */
  started: boolean
  /** 网络流是否已经结束（用于判断"播完即收尾"）。 */
  finished: boolean
  /** 是否已完成收尾（防止 finalize 重复执行）。 */
  closed: boolean
  /** 保底定时器句柄。 */
  watchdog?: number
  messageId: string
}

let stream: StreamState | undefined

/** 是否正在流式播放。 */
export function isStreaming(): boolean {
  return stream !== undefined
}

/** 停止流式播放（同时中止网络读取）。 */
export function stopStream(): void {
  if (!stream) return
  const s = stream
  s.closed = true
  if (s.watchdog !== undefined) window.clearInterval(s.watchdog)
  stream = undefined
  try { s.abort.abort() } catch { /* ignore */ }
  for (const src of s.sources) {
    try { src.stop() } catch { /* ignore */ }
  }
  s.sources.clear()
  try { void s.ctx.close() } catch { /* ignore */ }
  setPlayback({ playing: false, messageId: '', label: '' })
}

/** 停止一切播放，并**保证释放播放锁**（任何停止入口都必须能解锁）。 */
/* ────────────────────────── 自动播放排队 ────────────────────────── */

/**
 * 连续发送模式下，每个回合结束都会触发一次自动播放。
 * 如果新的一段直接开播，speakNow 开头的 stopAll 会把上一段掐断 ——
 * 表现出来就是"上一句没播完，新的来了就开始播新的"。
 *
 * 所以自动播放走队列：一条播完再播下一条，顺次听完。
 * 手动点击不排队 —— 那是明确意图，立即播，并清掉排着的自动播放。
 */
interface QueuedSpeak {
  text: string
  meta: { messageId: string; label: string; manual?: boolean }
  hooks: {
    onStart?: () => void
    onDone?: (info: { cached: boolean; firstMs?: number; totalMs?: number; skipped?: boolean }) => void
    onError?: (message: string) => void
  }
  resolve: () => void
  reject: (error: unknown) => void
}

const speakQueue: QueuedSpeak[] = []
let queueRunning = false

/** 队列里还有几条（含正在播的那条）。 */
export function queuedCount(): number {
  return speakQueue.length + (queueRunning ? 1 : 0)
}

/**
 * 等到这一段真正播完。
 *
 * 流式播放有两段生命周期：网络流结束 ≠ 声音播完。
 * 后者要等 AudioContext 里排程的 source 全部 onended（finalize 把 stream 置空）。
 * 队列必须按后者对齐，否则会提前开下一段把上一段掐掉。
 */
function waitPlaybackDone(timeoutMs = 180_000): Promise<void> {
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = (): void => {
      if (!isStreaming() && !isPlaying()) { resolve(); return }
      if (Date.now() >= deadline) { resolve(); return }
      window.setTimeout(tick, 150)
    }
    tick()
  })
}

/** 清空排队（正在播的那条不受影响，由 stopStream 处理）。 */
function clearQueue(): void {
  const pending = speakQueue.splice(0)
  for (const item of pending) item.resolve()
}

/** 依次消费队列，一条播完才播下一条。 */
async function drainQueue(): Promise<void> {
  if (queueRunning) return
  queueRunning = true
  try {
    for (;;) {
      const item = speakQueue.shift()
      if (!item) break
      try {
        await speakNow(item.text, item.meta, item.hooks)
        // speakNow 在网络流读完时就返回了，但音频还在 AudioContext 里播 ——
        // 必须等到真正播完（stream 收尾）再下一条，否则就是"上一句没播完新的就来了"。
        await waitPlaybackDone()
        item.resolve()
      } catch (error) {
        item.reject(error)
      }
    }
  } finally {
    queueRunning = false
  }
}

/**
 * 流式合成并边收边播。
 *
 * 自动播放（连续发送时系统触发的）会排队，等上一条播完再播；
 * 手动点击立即播，并清空队列。
 */
export async function speakStream(
  text: string,
  meta: { messageId: string; label: string; manual?: boolean },
  hooks: {
    onStart?: () => void
    onDone?: (info: { cached: boolean; firstMs?: number; totalMs?: number; skipped?: boolean }) => void
    onError?: (message: string) => void
  } = {},
): Promise<void> {
  if (meta.manual) {
    clearQueue()
    return speakNow(text, meta, hooks)
  }
  return new Promise<void>((resolve, reject) => {
    speakQueue.push({ text, meta, hooks, resolve, reject })
    void drainQueue()
  })
}

/**
 * 全部停止。
 * @param options.keepQueue - true 表示只停当前这段、保留排队中的下一段
 *   （自动播放切下一条时用；用户点停止时不传，连队列一起清掉）
 */
export function stopAll(options?: { keepQueue?: boolean }): void {
  if (!options?.keepQueue) clearQueue()
  stopStream()
  stopAudio()
}

/**
 * 流式合成并边收边播。
 *
 * 为什么要 AudioContext 而不是 <audio>：
 *   服务端推的是裸 PCM 分片，没有容器格式，<audio> 认不出；
 *   而 WebAudio 可以直接把小端 16 位 PCM 填进 AudioBuffer 排程播放，
 *   并且按 nextTime 精确接续，分片之间不会有空隙。
 *
 * @param text - 要朗读的正文
 * @param meta - 用于播放条展示与按钮高亮
 * @param hooks - 生命周期回调
 */
async function speakNow(
  text: string,
  meta: { messageId: string; label: string; manual?: boolean },
  hooks: {
    /** 首片开始播放 */
    onStart?: () => void
    /** 全部合成完成（可能还在播） */
    onDone?: (info: { cached: boolean; firstMs?: number; totalMs?: number; skipped?: boolean }) => void
    /** 出错 */
    onError?: (message: string) => void
  } = {},
): Promise<void> {
  // 去重只用于「自动播放」：那是系统触发的，可能在同一瞬间来两次。
  // 手动点击是用户的明确意图，永远不该被挡。
  if (!meta.manual && shouldDrop(`${meta.messageId}|${text}`)) {
    hooks.onDone?.({ cached: false, skipped: true })
    return
  }
  // 手动播放时刷新去重窗口，避免紧接着的自动播放重复触发
  if (meta.manual) {
    lastStartKey = `${meta.messageId}|${text}`
    lastStartAt = Date.now()
  }
  // 先清掉正在播的（stopAudio 会把状态复位），再开始新的播放。
  // keepQueue：这一条是队列消费出来的，不能把后面排着的也清掉。
  stopAll({ keepQueue: true })

  // 必须让 AudioContext 与数据采样率一致（24000）。
  // 若用设备原生率（48k），每个分片都要独立重采样，
  // 分片边界的重采样器状态不连续会产生轻微失真 —— 这正是流式听起来
  // 比缓存版"糊"的原因。设成 24000 后 buffer 与 context 同率，零重采样。
  const ctx = new AudioContext({ sampleRate: STREAM_SR })
  // 浏览器可能因自动播放策略挂起，这里尝试恢复（点击/自动播放都可能触发）
  if (ctx.state === 'suspended') {
    try { await ctx.resume() } catch { /* ignore */ }
  }

  const abort = new AbortController()
  const s: StreamState = { ctx, nextTime: ctx.currentTime + 0.06, sources: new Set(), abort, started: false, finished: false, closed: false, messageId: meta.messageId }
  stream = s
  setPlayback({ playing: true, messageId: meta.messageId, label: meta.label.replace(/\s+/g, ' ').slice(0, 40) })

  /** 是否已跳过开头静音（只在首个有声片之后置位）。 */
  let leadingSkipped = false

  /** 判断一片是否几乎全是静音（服务端首片常是纯静音缓冲）。 */
  const isSilent = (pcm: Int16Array): boolean => {
    // 抽样即可：每 32 个点取一个，够判断
    let acc = 0
    let n = 0
    for (let i = 0; i < pcm.length; i += 32) {
      acc += Math.abs(pcm[i])
      n++
    }
    return n > 0 && acc / n < 40
  }

  /** 收尾：幂等，任何一方先到都能触发，且只执行一次。 */
  const finalize = (): void => {
    if (stream !== s || s.closed) return
    // 必须「网络收完」+「排程队列播完」两者都成立
    if (!s.finished || s.sources.size > 0) return
    s.closed = true
    stream = undefined
    try { void s.ctx.close() } catch { /* ignore */ }
    setPlayback({ playing: false, messageId: '', label: '' })
  }

  /**
   * 保底定时器：网络已结束但 source 的 onended 迟迟不触发时（例如
   * 浏览器把页面判为后台而冻结音频时钟），到点强行收尾并解锁。
   * 这比"永久卡住、之后怎么点都没声"要好得多。
   */
  const watchdog = window.setInterval(() => {
    if (s.closed) { window.clearInterval(watchdog); return }
    if (!s.finished) return
    const remain = s.nextTime - s.ctx.currentTime
    if (remain <= 0.05 && s.sources.size === 0) {
      window.clearInterval(watchdog)
      finalize()
      return
    }
    // nextTime 已经过去很久但还有 source 挂着：认定异常，强收
    if (remain < -3) {
      window.clearInterval(watchdog)
      for (const src of s.sources) {
        try { src.stop() } catch { /* ignore */ }
      }
      s.sources.clear()
      finalize()
    }
  }, 1000)
  s.watchdog = watchdog

  /** 把一片 PCM 排进播放队列。 */
  const enqueue = (pcm: Int16Array): void => {
    if (!stream || stream !== s) return
    if (pcm.length === 0) return

    // 开头静音片直接丢弃：缓存里存的是裁过的版本，流式也该对齐，
    // 否则"首片静音"会让听感比缓存版慢半拍。
    if (!leadingSkipped) {
      if (isSilent(pcm)) return
      leadingSkipped = true
    }

    const buf = ctx.createBuffer(1, pcm.length, STREAM_SR)
    const ch = buf.getChannelData(0)
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    // 排程接续：如果落后于当前时间就立即播，否则顺延
    const at = Math.max(s.nextTime, ctx.currentTime + 0.02)
    src.start(at)
    s.nextTime = at + buf.duration
    s.sources.add(src)
    src.onended = () => {
      s.sources.delete(src)
      finalize()
    }
    if (!s.started) {
      s.started = true
      hooks.onStart?.()
    }
  }

  try {
    const res = await fetch(`${PREFIX}/speak-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: abort.signal,
    })

    if (!res.ok) {
      // 宿主判定不能流式（比如 DeepSeek 引擎 / 未启用）：退回非流式
      const detail = (await res.json().catch(() => ({}))) as { error?: string; fallback?: boolean }
      stream = undefined
      try { void ctx.close() } catch { /* ignore */ }
      const r = await api.speak(text)
      if (!r.ok || !r.url) throw new Error(r.error ?? detail.error ?? '合成失败')
      playAudio(r.url, meta)
      hooks.onStart?.()
      hooks.onDone?.({ cached: Boolean(r.cached), totalMs: r.ms })
      return
    }

    if (!res.body) throw new Error('流式响应没有 body')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        idx = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue

        let j: any
        try { j = JSON.parse(payload) } catch { continue }

        if (j.pcm) {
          const raw = atob(j.pcm)
          const bytes = new Uint8Array(raw.length)
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
          // 小端 16 位
          const view = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1)
          enqueue(view)
        } else if (j.ok === false && j.error) {
          throw new Error(j.error)
        } else if (j.cached === true && j.url) {
          // 缓存命中：服务端只推这一个事件（同时带 cached:true 与 url），
          // 流里没有 pcm 分片，直接整段播放。
          // 流式完成的那条 done 事件虽然也带 url（给下次复用），
          // 但它的 cached 是 false，不会走到这里 —— 这是区分两者的唯一依据。
          s.closed = true
          window.clearInterval(watchdog)
          if (stream === s) {
            stream = undefined
            try { void ctx.close() } catch { /* ignore */ }
          }
          playAudio(j.url, meta)
          s.started = true
          hooks.onStart?.()
          hooks.onDone?.({ cached: true })
        } else if (j.firstMs !== undefined || j.totalMs !== undefined) {
          // done 事件（流式路径）：标记网络结束，只记录不重播
          s.finished = true
          hooks.onDone?.({ cached: false, firstMs: j.firstMs, totalMs: j.totalMs })
          finalize()
        }
      }
    }
    // 兜底：读到流尾（无论有没有收到 done）
    s.finished = true
    finalize()
  } catch (e) {
    const msg = (e as Error).message
    if (s.closed) return
    s.closed = true
    window.clearInterval(watchdog)
    if (stream === s) {
      stream = undefined
      try { void ctx.close() } catch { /* ignore */ }
      setPlayback({ playing: false, messageId: '', label: '' })
    }
    if (/abort/i.test(msg)) return // 用户主动停止，不算错误
    hooks.onError?.(msg)
  }
}

/* ────────────────────────── 自动播放开关（跨组件共享） ────────────────────────── */

/** 兼容旧调用：始终允许（时间窗由 speakStream 内部处理）。 */
export function acquirePlayLock(): boolean {
  return true
}

/** 兼容旧调用：无操作。 */
export function releasePlayLock(): void {
  /* noop */
}

/** 当前是否正在播（不再依赖锁）。 */
export function isPlayLocked(): boolean {
  return stream !== undefined || currentAudio !== undefined
}

/**
 * 自动播放需要两个条件同时成立：全局启用 + 自动播放开关打开。
 * 状态放在模块级，SettingsRow 写入、每个 SpeakerButton 订阅，
 * 这样不用把 props 一层层传。
 */
let autoFlags = { enabled: false, autoPlay: false }
const autoListeners = new Set<() => void>()

/** 由设置面板在拿到最新 state 后写入。 */
export function updateAutoFlags(enabled: boolean, autoPlay: boolean): void {
  if (autoFlags.enabled === enabled && autoFlags.autoPlay === autoPlay) return
  autoFlags = { enabled, autoPlay }
  for (const fn of autoListeners) fn()
}

/** 当前是否应当自动朗读（启用 且 自动播放）。 */
export function shouldAutoPlay(): boolean {
  return autoFlags.enabled && autoFlags.autoPlay
}

/** 订阅：返回取消订阅函数。 */
export function subscribeAutoFlags(fn: () => void): () => void {
  autoListeners.add(fn)
  return () => {
    autoListeners.delete(fn)
  }
}

/**
 * 已经自动播过的消息 id。
 * 防止同一段文本因流式更新被重复触发，也防止重渲染时重播。
 */
const autoPlayed = new Set<string>()

/** 是否已经自动播过这条消息。 */
export function hasAutoPlayed(id: string): boolean {
  return autoPlayed.has(id)
}

/** 标记为已自动播放。 */
export function markAutoPlayed(id: string): void {
  autoPlayed.add(id)
}
