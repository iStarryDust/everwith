/**
 * 聊天里的「记住」：动作行上一个按钮 + 一个勾选弹窗。
 *
 * 点按钮展开聊天记录列表，勾中要提炼的消息，提交后交给会话自己的模型
 * 压成几条稳定事实，追加进 memory.md。
 *
 * 按钮本身不写任何东西：只有勾选并提交，才会产生一次提炼。
 */
import { useCallback, useMemo, useState } from 'react'

const StarIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M7.6 2.3l1 3.1a2 2 0 0 0 1.3 1.3l3.1 1-3.1 1a2 2 0 0 0-1.3 1.3l-1 3.1-1-3.1a2 2 0 0 0-1.3-1.3l-3.1-1 3.1-1a2 2 0 0 0 1.3-1.3l1-3.1z"
      fill="currentColor"
    />
    <path
      d="M12.4 2.1l.4 1.1 1.1.4-1.1.4-.4 1.1-.4-1.1-1.1-.4 1.1-.4.4-1.1z"
      fill="currentColor"
      opacity="0.85"
    />
  </svg>
)

const API = '/api/everwith/settings'
const MAX_CHARS = 18000

/**
 * 消息块里只收正文。
 * 宿主的块用 kind 区分(text / reasoning / tool…),这里两种字段名都认,
 * 免得换了版本就全被过滤掉。
 */
const blockText = (b) => {
  if (typeof b?.text !== 'string') return ''
  const kind = b.kind ?? b.type
  return kind === 'text' ? b.text : ''
}

const assistantText = (blocks) => {
  const parts = []
  for (const b of blocks ?? []) parts.push(blockText(b))
  return parts.filter(Boolean).join('\n').trim()
}

const contentText = (content) => {
  const parts = []
  for (const c of content ?? []) parts.push(blockText(c))
  return parts.filter(Boolean).join('\n').trim()
}

/** 把 chat state 摊平成按时间排好的消息列表 */
function candidatesOf(snapshot) {
  const store = snapshot?.nodes
  const nodes =
    store == null
      ? []
      : typeof store.values === 'function'
        ? store.values()
        : store instanceof Map
          ? [...store.values()]
          : Object.values(store)
  const list = []
  for (const raw of nodes) {
    if (typeof raw !== 'object' || raw === null) continue
    const node = raw
    const key = node.key ?? node.id
    if (key === undefined) continue
    if (node.visibility === 'hidden') continue
    const seq = typeof node.anchorSeq === 'number' ? node.anchorSeq : 0
    if (node.kind === 'user' || node.kind === 'steering') {
      const text = Array.isArray(node.data?.content) ? contentText(node.data.content) : ''
      if (text.trim() === '') continue
      list.push({ key, seq, side: 'user', text })
      continue
    }
    if (node.kind === 'assistant-step') {
      const st = node.data?.status
      if (st === 'running') continue
      const text = Array.isArray(node.data?.blocks) ? assistantText(node.data.blocks) : ''
      if (text.trim() === '') continue
      list.push({ key, seq, side: 'assistant', text })
    }
  }
  return list.sort((a, b) => a.seq - b.seq)
}

const preview = (text) => {
  try {
    const one = String(text ?? '').replace(/\s+/g, ' ').trim()
    return one.length > 90 ? one.slice(0, 90) + '…' : one
  } catch {
    return ''
  }
}

const C = {
  mask: {
    position: 'fixed',
    inset: 0,
    background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.24))',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2000,
  },
  panel: {
    width: 'min(680px, 92vw)',
    maxHeight: '76vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    border: '.5px solid var(--dsw-alias-border-l2)',
    borderRadius: 'var(--dsw-radius-lg)',
    boxShadow: '0 18px 48px rgba(0,0,0,0.18)',
    overflow: 'hidden',
  },
  head: { padding: '16px 18px 10px' },
  title: { fontSize: 15, fontWeight: 600, marginBottom: 4, color: 'var(--dsw-alias-label-primary)' },
  sub: { fontSize: 12, opacity: 0.75, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
  list: { overflowY: 'auto', padding: '4px 10px 8px', flex: 1 },
  row: (checked) => ({
    display: 'flex',
    gap: 10,
    alignItems: 'flex-start',
    padding: '7px 8px',
    borderRadius: 'var(--dsw-radius-sm, 6px)',
    cursor: 'pointer',
    background: checked ? 'var(--dsw-alias-bg-module-platform)' : 'transparent',
  }),
  side: (isUser) => ({
    fontSize: 11,
    lineHeight: '18px',
    padding: '0 6px',
    borderRadius: 5,
    flexShrink: 0,
    background: 'var(--dsw-alias-bg-layer-3)',
    color: 'var(--dsw-alias-label-tertiary)',
    whiteSpace: 'nowrap',
  }),
  text: { fontSize: 12.5, lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-word' },
  foot: {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    justifyContent: 'flex-end',
    padding: '10px 16px 14px',
    borderTop: '.5px solid var(--dsw-alias-border-l2)',
  },
  note: { marginRight: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  btn: (primary) => ({
    padding: '6px 14px',
    borderRadius: 'var(--dsw-radius-sm, 6px)',
    border: primary ? 'none' : '.5px solid var(--dsw-alias-border-l3)',
    background: primary ? 'var(--dsw-alias-state-business-primary)' : 'transparent',
    color: primary ? '#fff' : 'var(--dsw-alias-label-primary)',
    fontSize: 13,
    cursor: 'pointer',
  }),
}

/**
 * 动作行上的按钮本体。
 * 只有确认 useChat 是函数才会走到这里,所以内部可以放心调用。
 * @param props - 宿主注入的 useChat。
 */
function RememberInner({ useChat }) {
  // 宿主这个 hook 有可能在某些场景下抛错;包起来,拿不到就当空会话。
  // 同步抛错能被 catch 接住,不会冒到 React 那边把整棵树立掉。
  let snapshot = null
  try {
    snapshot = useChat((state) => state)
  } catch {
    snapshot = null
  }
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const [checked, setChecked] = useState(new Set())
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const list = useMemo(() => {
    if (!open) return []
    try {
      return candidatesOf(snapshot)
    } catch {
      return []
    }
  }, [open, snapshot])

  const toggle = (key) => {
    const next = new Set(checked)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setChecked(next)
  }

  const close = () => {
    if (busy) return
    setOpen(false)
    setChecked(new Set())
    setNote('')
  }

  const submit = useCallback(async () => {
    if (busy) return
    const picked = list.filter((m) => checked.has(m.key))
    if (!picked.length) {
      setNote('先勾几条')
      return
    }
    let text = picked.map((m) => `${m.side === 'user' ? '用户' : '助手'}：${m.text}`).join('\n\n')
    if (text.length > MAX_CHARS) text = text.slice(-MAX_CHARS)
    setBusy(true)
    setNote('提炼中…')
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ extract: text }),
      })
      const d = await r.json()
      if (!d?.ok) throw new Error(d?.error || '失败')
      const ex = d.extract ?? {}
      if (ex.error) throw new Error(ex.error)
      setNote(`记下 ${ex.added ?? 0} 条，刷新 ${ex.refreshed ?? 0} 条`)
      setChecked(new Set())
      setTimeout(() => {
        setOpen(false)
        setNote('')
      }, 1400)
    } catch (error) {
      setNote(`没成：${String(error?.message ?? error).slice(0, 60)}`)
    } finally {
      setBusy(false)
    }
  }, [busy, checked, list])

  return (
    <>
      <button
        type="button"
        title="把聊过的记进长期记忆"
        aria-label="记住"
        onClick={() => setOpen(true)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          boxSizing: 'border-box',
          width: 28,
          height: 28,
          padding: 6,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          borderRadius: 6,
          background: hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.16))' : 'transparent',
          color: 'var(--dsw-alias-label-tertiary)',
          cursor: 'pointer',
          lineHeight: 0,
          flexShrink: 0,
        }}
      >
        <StarIcon />
      </button>

      {open ? (
        <div style={C.mask} onClick={close}>
          <div style={C.panel} onClick={(e) => e.stopPropagation()}>
            <div style={C.head}>
              <div style={C.title}>记进长期记忆</div>
              <div style={C.sub}>勾选要提炼的消息，模型会把它们压成几条稳定的事实，追加到档案里。</div>
            </div>
            <div style={C.list}>
              {list.length === 0 ? (
                <div style={{ ...C.sub, padding: '18px 10px' }}>这个会话还没有可提炼的消息。</div>
              ) : (
                list.map((m) => (
                  <label key={m.key} style={C.row(checked.has(m.key))}>
                    <input
                      type="checkbox"
                      checked={checked.has(m.key)}
                      onChange={() => toggle(m.key)}
                      style={{ marginTop: 3 }}
                    />
                    <span style={C.side(m.side === 'user')}>{m.side === 'user' ? '你' : '她'}</span>
                    <span style={C.text}>{preview(m.text)}</span>
                  </label>
                ))
              )}
            </div>
            <div style={C.foot}>
              <span style={C.note}>{note || (checked.size ? `已选 ${checked.size} 条` : '')}</span>
              <button type="button" style={C.btn(false)} onClick={close} disabled={busy}>
                取消
              </button>
              <button type="button" style={C.btn(true)} onClick={() => void submit()} disabled={busy || checked.size === 0}>
                {busy ? '提炼中…' : '提炼并记住'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

/**
 * 动作行上的「记住」按钮(带兜底)。
 * @param props - 宿主注入的 useChat。
 */
export function RememberAction(props) {
  // 拿不到 useChat 就什么都不渲染 —— 不调用任何 hook,也就不会抛错
  if (typeof props?.useChat !== 'function') return null
  return <RememberInner {...props} />
}
