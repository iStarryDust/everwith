/**
 * 通话状态同步 —— 不提供按钮，只把 dsh-voice-mode 的开关状态转告宿主。
 *
 * 为什么不做按钮：麦克风、识别、打断、朗读全部是 dsh-voice-mode 的活，
 * 我们再做一开关只会让人分不清点哪个。那边一开语音模式，我们就知道
 * "现在是说话不是打字"，于是注入那句提示词；那边一关，我们跟着退出。
 *
 * 状态来源：GET /api/voice-mode（同源，带 cookie）。
 * 它的响应里有 active 字段 —— 全局单活，同一时刻只有一个会话在语音模式。
 */
import { useEffect, useRef } from 'react'

const SYNC_ENDPOINT = '/api/everwith/call'
const VOICE_STATE_ENDPOINT = '/api/voice-mode'
const POLL_MS = 1500
const TAG = '[everwith]'

/** 从 slot props 里尽力抠出会话 id（voice-mode 是按会话单活的）。 */
function sessionIdOf(props: Record<string, unknown> | undefined): string {
  const anyProps = props as
    | { sessionId?: unknown; session?: { id?: unknown }; scope?: { session?: { id?: unknown } } }
    | undefined
  const direct = anyProps?.sessionId ?? anyProps?.session?.id ?? anyProps?.scope?.session?.id
  return typeof direct === 'string' ? direct : ''
}

/**
 * 挂在输入框上的隐形组件：只跑轮询，不渲染任何东西。
 *
 * 用空 <span> 占位是因为 slot 需要一个组件；它没有可见尺寸，也不吃点击。
 */
export function CallSync(props: Record<string, unknown>): React.ReactElement | null {
  const lastRef = useRef<boolean | null>(null)
  const idRef = useRef('')
  idRef.current = sessionIdOf(props)

  useEffect(() => {
    let alive = true
    let timer = 0

    const poll = async (): Promise<void> => {
      if (!alive) return
      try {
        const res = await fetch(VOICE_STATE_ENDPOINT, { credentials: 'same-origin' })
        // 404/401 表示语音插件没装或没启用 —— 静默当作"不在通话"
        const active = res.ok ? Boolean(((await res.json()) as { active?: boolean })?.active) : false
        if (!alive) return

        if (lastRef.current !== active) {
          lastRef.current = active
          console.log(`${TAG} 语音模式 ${active ? '开' : '关'} → 同步给宿主`)
          await fetch(SYNC_ENDPOINT, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: active, sessionId: idRef.current }),
          }).catch(() => undefined)
        }
      } catch {
        /* 网络抖一下不当回事，下一轮再说 */
      }
      if (alive) timer = window.setTimeout(() => void poll(), POLL_MS)
    }

    void poll()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [])

  return null
}
