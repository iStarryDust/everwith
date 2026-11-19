/**
 * 实时语音输入 —— 点一次开麦，之后一直听，不再自己关。
 *
 * 链路：
 *   麦克风 → ScriptProcessor → 每片 PCM 进队列 → 串行 POST 给宿主
 *     → 宿主用 sherpa-onnx 识别 → 累积文字 → 边说边填进输入框
 *     → 出过声且静音 1.2 秒 → 结算这一句发出去 → 继续听
 *
 * 为什么排队串行：浏览器每 170ms 就产出一片，如果不等上一片回包就发下一片，
 * 请求会堆在 Electron 的网络层上，实测会出现 net::ERR_UNEXPECTED 被掐断，
 * 丢的正好是关键的那一片，一句话就识别不全。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { readMic } from './mic-settings.ts'

const FEED = '/api/spoon-companion/asr/feed'
const CLOSE = '/api/spoon-companion/asr/close'
const STATUS = '/api/spoon-companion/asr/status'
const CALL = '/api/spoon-companion/call'
/** 上一次打出来的通话状态，避免心跳刷屏 */
let lastLoggedRef: boolean | null = null
const TAG = '[spoon-companion]'

const TARGET_RATE = 16000
/** 静音多久算一句说完（ms） */
const SILENCE_MS = 1800
/** 单句最长（ms） */
const MAX_UTTERANCE_MS = 20000
/** 音量阈值不再写死：从设置页的麦克风参数里读（mic-settings.ts） */
/** 待发队列上限，超了就丢最老的（宁可丢也不堆） */
const MAX_QUEUE = 8
/** 一片多少个采样。48k 下 8192 ≈ 170ms */
const BUFFER_SIZE = 8192

function toBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[])
  }
  return btoa(binary)
}

function rms(arr: Float32Array): number {
  let sum = 0
  let n = 0
  for (let i = 0; i < arr.length; i += 4) {
    sum += arr[i] * arr[i]
    n++
  }
  return Math.sqrt(sum / Math.max(1, n))
}

function findInput(): HTMLTextAreaElement | HTMLElement | null {
  return document.querySelector<HTMLTextAreaElement | HTMLElement>(
    'textarea:not([readonly]), [contenteditable="true"]',
  )
}

/** 把文字填进输入框（不发）。 */
function fillInput(text: string): void {
  const el = findInput()
  if (!el) {
    console.warn(`${TAG} 找不到输入框`)
    return
  }
  if (el instanceof HTMLTextAreaElement) {
    // React 会在元素上挂 _valueTracker 记"上次的值"。不把它清掉的话，
    // 用原生 setter 改值 + 派发 input 事件，React 认为没变，onChange 不触发，
    // 表现就是"输入框里看似有字，但框架完全不知道"。
    const tracker = (el as unknown as { _valueTracker?: { setValue: (v: string) => void } })
      ._valueTracker
    if (tracker) tracker.setValue('')

    const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
    if (desc?.set) desc.set.call(el, text)
    else el.value = text
  } else {
    el.textContent = text
    el.focus()
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

/** 提交。优先点发送按钮 —— 合成键盘事件 isTrusted 是 false，很多实现会直接忽略。 */
function submitInput(): void {
  const el = findInput()

  const btn = document.querySelector<HTMLButtonElement>(
    'button[aria-label*="发送"], button[aria-label*="Send" i], button[title*="发送"], button[type="submit"]',
  )
  if (btn && !btn.disabled) {
    btn.click()
    console.log(`${TAG} 点了发送按钮`)
    return
  }

  if (!el) {
    console.warn(`${TAG} 既没有发送按钮也没有输入框`)
    return
  }
  el.focus()
  for (const type of ['keydown', 'keyup']) {
    el.dispatchEvent(
      new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }),
    )
  }
  console.log(`${TAG} 没有发送按钮，试了回车`)
}

async function setCall(on: boolean): Promise<void> {
  try {
    const res = await fetch(CALL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    })
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; on?: boolean; lastBody?: unknown; global?: boolean }
      | null
    // 心跳每 1.5 秒一次，只在状态翻转时出声，否则控制台会被刷满
    if (lastLoggedRef !== data?.on) {
      lastLoggedRef = data?.on === true
      console.log(`${TAG} 通话状态 → ${data?.on ? '开' : '关'}（HTTP ${res.status}）`)
    }
  } catch (error) {
    // 静默失败会让"模型不知道在通话"变成查不出来的问题，这里必须出声
    console.warn(`${TAG} 通话状态通知失败`, error)
  }
}

/** 从 slot props 里尽量抠出会话 id。 */
function sessionIdOf(props: Record<string, unknown> | undefined): string {
  const anyProps = props as
    | { sessionId?: unknown; session?: { id?: unknown }; scope?: { session?: { id?: unknown } } }
    | undefined
  const direct = anyProps?.sessionId ?? anyProps?.session?.id ?? anyProps?.scope?.session?.id
  return typeof direct === 'string' ? direct : ''
}

/** 发送回调：由 index.ts 注入，走 DSH 的 session.prompt()。 */
type Sender = (sessionId: string, text: string) => Promise<boolean>

export function VoiceButton(
  props: Record<string, unknown> & { send?: Sender },
): React.ReactElement {
  const [on, setOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [level, setLevel] = useState(0)

  // send 会随渲染变化，用 ref 拿最新的一份
  const sendRef = useRef<Sender | undefined>(props.send)
  sendRef.current = props.send
  const propsRef = useRef(props)
  propsRef.current = props

  const ctxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const nodeRef = useRef<ScriptProcessorNode | null>(null)
  const asrIdRef = useRef('')
  const lastVoiceRef = useRef(0)
  const startedRef = useRef(0)
  const textRef = useRef('')
  const nativeRateRef = useRef(TARGET_RATE)
  const aliveRef = useRef(true)
  const spokeRef = useRef(false)
  const queueRef = useRef<Float32Array[]>([])
  const pumpingRef = useRef(false)
  const flushingRef = useRef(false)
  const feedCountRef = useRef(0)

  /**
   * 真正关麦。
   * @param quiet 为 true 时不通知宿主 —— 组件卸载（重渲染、切会话）走这条，
   *        否则刚开的通话状态会被立刻按回去，宿主永远停在 false。
   */
  const hardStop = useCallback(async (quiet = false): Promise<void> => {
    queueRef.current = []
    try { nodeRef.current?.disconnect() } catch { /* ignore */ }
    nodeRef.current = null
    try { streamRef.current?.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
    streamRef.current = null
    try { await ctxRef.current?.close() } catch { /* ignore */ }
    ctxRef.current = null
    setOn(false)
    setLevel(0)
    if (!quiet) void setCall(false)
  }, [])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      // 卸载时保持宿主状态，别把正在进行的通话冲掉
      void hardStop(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 心跳：只要麦克风开着，定期重申一遍"在通话"。
   *
   * 为什么不只靠开麦时那一次通知：那一次如果因为时序、重渲染、请求被丢弃
   * 而没生效，宿主就永远停在 false，而且从日志里很难看出是哪一步丢的。
   * 每 1.5 秒重申一次，错一次下一次就纠回来了，自我修复。
   */
  useEffect(() => {
    if (!on) return
    void setCall(true)
    const timer = window.setInterval(() => {
      if (aliveRef.current) void setCall(true)
    }, 1500)
    return () => window.clearInterval(timer)
  }, [on])

  /**
   * 结算当前这一句：发送出去，然后继续听。
   * 说话结束 ≠ 麦克风结束，这是"实时"的关键。
   */
  const flush = useCallback(async (): Promise<void> => {
    if (flushingRef.current) return
    flushingRef.current = true
    const id = asrIdRef.current
    asrIdRef.current = ''
    let final = textRef.current
    if (id) {
      try {
        const res = await fetch(CLOSE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ streamId: id }),
        })
        const data = (await res.json()) as { text?: string }
        if (data?.text) final = data.text
      } catch {
        /* 用已攒到的 */
      }
    }
    textRef.current = ''
    spokeRef.current = false
    // 队列里可能还压着上一句的残留，不能让它混进下一句——
    // 那会让识别结果开头多出几个字
    queueRef.current = []
    const trimmed = final.trim()
    if (trimmed) {
      console.log(`${TAG} 识别完成：「${trimmed}」`)
      const sid = sessionIdOf(propsRef.current)
      const sender = sendRef.current
      // 优先走 DSH 的会话接口；拿不到会话或失败才退回 DOM
      const ok = sid && sender ? await sender(sid, trimmed) : false
      if (ok) {
        console.log(`${TAG} 已通过 session.prompt 送出`)
      } else {
        console.warn(`${TAG} 会话接口不可用（sid=${sid || '空'}），退回 DOM`)
        fillInput(trimmed)
        window.setTimeout(() => submitInput(), 120)
      }
      lastVoiceRef.current = Date.now()
      startedRef.current = Date.now()
      spokeRef.current = false
      flushingRef.current = false
      return
    }
    lastVoiceRef.current = Date.now()
    startedRef.current = Date.now()
    flushingRef.current = false
  }, [])

  /**
   * 队列泵：一片一片串行发。
   * 不串行的话请求会堆到 Electron 网络层，出现 ERR_UNEXPECTED 被掐断。
   */
  const pump = useCallback(async (): Promise<void> => {
    if (pumpingRef.current) return
    pumpingRef.current = true
    try {
      while (queueRef.current.length > 0 && aliveRef.current) {
        const pcm = queueRef.current.shift()
        if (!pcm) break
        try {
          const res = await fetch(FEED, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pcm: toBase64(pcm), rate: nativeRateRef.current }),
          })
          const data = (await res.json()) as {
            streamId?: string
            text?: string
            level?: number
          }
          if (!aliveRef.current) return

          if (typeof data?.level === 'number') {
            setLevel(data.level > 0.01 ? Math.min(1, data.level * 12) : 0)
            feedCountRef.current++
            if (feedCountRef.current % 6 === 0) {
              console.log(`${TAG} 音量 ${data.level.toFixed(5)}（人声通常 >0.02）`)
            }
          }
          if (data?.streamId) asrIdRef.current = data.streamId
          if (data?.text) {
            textRef.current = data.text
            fillInput(data.text)
          }

          const silentFor = Date.now() - lastVoiceRef.current
          const tooLong = Date.now() - startedRef.current > MAX_UTTERANCE_MS
          if (spokeRef.current && (silentFor > SILENCE_MS || tooLong)) {
            await flush()
          }
        } catch (error) {
          // 单片失败不中断：丢掉这一片，继续下一片
          console.warn(`${TAG} 送音频失败`, error)
        }
      }
    } finally {
      pumpingRef.current = false
    }
  }, [flush])

  const start = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const st = (await (await fetch(STATUS)).json()) as { ready?: boolean; missing?: string[] }
      if (!st?.ready) {
        console.warn(`${TAG} 模型缺失: ${st?.missing?.join(', ')}`)
        setBusy(false)
        return
      }

      // 约束跟设置页里的麦克风参数走（降噪 / 回声消除 / 自动增益）
      const micCfg = readMic()
      const media = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: micCfg.echoCancel,
          noiseSuppression: micCfg.denoise,
          autoGainControl: micCfg.autoGain,
        },
      })
      streamRef.current = media
      const track = media.getAudioTracks()[0]
      console.log(`${TAG} 麦克风: ${track?.label ?? '未知'}`)
      // 把 slot 给我们的字段名打出来：sessionId 从哪个字段来，一看就知道
      console.log(`${TAG} slot props: ${JSON.stringify(Object.keys(propsRef.current))}`)
      console.log(`${TAG} 解析出的 sessionId: ${sessionIdOf(propsRef.current) || '(空)'}`)

      const audioCtx = new AudioContext()
      ctxRef.current = audioCtx
      if (audioCtx.state === 'suspended') await audioCtx.resume()
      nativeRateRef.current = audioCtx.sampleRate
      console.log(`${TAG} 采样率 ${audioCtx.sampleRate}Hz`)

      const source = audioCtx.createMediaStreamSource(media)
      const node = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1)
      nodeRef.current = node

      // 输入增益：设在 source 和识别之间，推给识别的是放大后的信号
      const gainNode = audioCtx.createGain()
      gainNode.gain.value = micCfg.gain
      source.connect(gainNode)
      gainNode.connect(node)

      // 监听自己：gain 给 1 就能从耳机里听见自己的声音，用来调阈值
      const mute = audioCtx.createGain()
      mute.gain.value = micCfg.monitor ? 1 : 0
      node.connect(mute)
      mute.connect(audioCtx.destination)

      textRef.current = ''
      queueRef.current = []
      spokeRef.current = false
      feedCountRef.current = 0
      lastVoiceRef.current = Date.now()
      startedRef.current = Date.now()

      node.onaudioprocess = (ev) => {
        if (!aliveRef.current) return
        const pcm = new Float32Array(ev.inputBuffer.getChannelData(0))

        if (rms(pcm) > micCfg.level) {
          lastVoiceRef.current = Date.now()
          spokeRef.current = true
        }

        // 队列满了就丢最老的，绝不无限堆
        if (queueRef.current.length >= MAX_QUEUE) queueRef.current.shift()
        queueRef.current.push(pcm)
        void pump()
      }

      setOn(true)
      setBusy(false)
      void setCall(true)
      console.log(`${TAG} 开始听（串行推送）`)
    } catch (error) {
      console.warn(`${TAG} 开麦失败`, error)
      setBusy(false)
      await hardStop()
    }
  }, [hardStop, pump])

  const toggle = useCallback(async (): Promise<void> => {
    if (busy) return
    if (on) {
      await flush()
      await hardStop()
    } else {
      await start()
    }
  }, [busy, on, flush, hardStop, start])

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      aria-pressed={on}
      title={on ? (level > 0 ? '正在听你说话' : '已开麦，等一下声音') : '开始语音'}
      data-spoon-mic={on ? 'on' : 'off'}
      className={`sp-mic${on ? ' sp-mic--on' : ''}${busy ? ' sp-mic--busy' : ''}${level > 0 ? ' sp-mic--hearing' : ''}`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
        <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
        <line x1="12" y1="18" x2="12" y2="22" />
      </svg>
    </button>
  )
}

export const MIC_CSS = `
.sp-mic {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0;
  border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: inherit; opacity: 0.55; cursor: pointer;
  pointer-events: auto; position: relative; z-index: 1;
  transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
}
.sp-mic:hover:not(:disabled) { opacity: 1; background: rgba(127,127,127,.12); }
.sp-mic:disabled { cursor: default; }
.sp-mic--on {
  opacity: 1; color: #e0455a;
  background: rgba(224,69,90,.14);
  border-color: rgba(224,69,90,.35);
  animation: sp-mic-pulse 1.6s ease-in-out infinite;
}
.sp-mic--hearing {
  color: #16a34a;
  background: rgba(22,163,74,.16);
  border-color: rgba(22,163,74,.5);
  animation: sp-mic-hearing .9s ease-in-out infinite;
}
.sp-mic--busy { opacity: .4; }
@keyframes sp-mic-pulse {
  0%,100% { box-shadow: 0 0 0 0 rgba(224,69,90,.35); }
  50% { box-shadow: 0 0 0 5px rgba(224,69,90,0); }
}
@keyframes sp-mic-hearing {
  0%,100% { box-shadow: 0 0 0 0 rgba(22,163,74,.4); }
  50% { box-shadow: 0 0 0 6px rgba(22,163,74,0); }
}
`
