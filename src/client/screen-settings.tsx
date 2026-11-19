/**
 * 设置 → Spoon 陪伴
 *
 * 看屏幕的开关和节奏都在这里调。数据走宿主侧的 /api/spoon-companion/screen,
 * 改完立刻生效(宿主那边会重排定时器),不用重启。
 */

import { useCallback, useEffect, useState } from 'react'

const API = '/api/spoon-companion/screen'

type Snapshot = {
  ok: boolean
  config: {
    enabled: boolean
    baseMinutes: number
    minMinutes: number
    maxMinutes: number
    nightFactor: number
    dailyLimit: number
    speak: string
  }
  state: {
    lastAt: number
    title: string
    today: number
    inMinutes: number
    everyMinutes: number
    night: boolean
    fails: number
  }
  now: number
}

const box: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  padding: '4px 2px 24px',
  maxWidth: 620,
  fontSize: 13,
}
const rowTitle: React.CSSProperties = { fontWeight: 600, fontSize: 14 }
const hint: React.CSSProperties = { opacity: 0.6, lineHeight: 1.6, marginTop: 2 }
const group: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const sliderRow: React.CSSProperties = { display: 'grid', gridTemplateColumns: '96px 1fr 92px', alignItems: 'center', gap: 10 }
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', opacity: 0.85 }
const card: React.CSSProperties = {
  border: '1px solid rgba(128,128,128,0.28)',
  borderRadius: 10,
  padding: '12px 14px',
  display: 'grid',
  gap: 6,
}
const kv: React.CSSProperties = { display: 'grid', gridTemplateColumns: '72px 1fr', gap: 8, fontSize: 12.5 }

function ago(at: number, now: number) {
  if (!at) return '还没看过'
  const mins = Math.floor(Math.max(0, now - at) / 60_000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  return `${Math.floor(mins / 60)} 小时前`
}

export function ScreenSettingsSection() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(API, { headers: { accept: 'application/json' } })
      const data = (await res.json()) as Snapshot
      if (data?.ok) {
        setSnap(data)
        setError('')
      } else {
        setError('读不到设置')
      }
    } catch (reason) {
      setError(String(reason))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [load])

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true)
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = (await res.json()) as Snapshot
      if (data?.ok) {
        setSnap(data)
        setError('')
      } else {
        setError('保存失败')
      }
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  const cfg = snap?.config
  const st = snap?.state

  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    suffix: string,
    onCommit: (next: number) => void,
  ) => (
    <label style={sliderRow}>
      <span style={{ opacity: 0.8 }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        disabled={busy}
        onChange={(event) => onCommit(Number(event.target.value))}
        style={{ width: '100%' }}
      />
      <span style={num}>
        {value} {suffix}
      </span>
    </label>
  )

  return (
    <div style={box}>
      <div style={group}>
        <div style={rowTitle}>看屏幕</div>
        <div style={hint}>
          她偶尔走过去看一眼，不是监视。看一眼的频率由情绪决定：孤单的时候想看你，烦的时候不想看，困的时候几乎不看。
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={cfg?.enabled === true}
            disabled={busy || !cfg}
            onChange={(event) => void save({ enabled: event.target.checked })}
          />
          <span>{cfg?.enabled ? '开着 —— 会自己看' : '关着 —— 一次都不截'}</span>
        </label>
      </div>

      <div style={group}>
        <div style={{ ...rowTitle, opacity: cfg?.enabled ? 1 : 0.45 }}>节奏</div>
        {cfg ? (
          <>
            {slider('整体快慢', cfg.baseMinutes, 2, 30, '分钟', (next) => void save({ baseMinutes: next }))}
            {slider('最短', cfg.minMinutes, 1, 15, '分钟', (next) => void save({ minMinutes: next }))}
            {slider('最长', cfg.maxMinutes, 10, 180, '分钟', (next) => void save({ maxMinutes: next }))}
            {slider('深夜', cfg.nightFactor, 2, 20, '×', (next) => void save({ nightFactor: next }))}
            {slider('每天最多', cfg.dailyLimit, 10, 500, '次', (next) => void save({ dailyLimit: next }))}
          </>
        ) : (
          <div style={hint}>读设置中…</div>
        )}
        <div style={hint}>
          深夜是低频，不是不看。倍数越大越少看（8× 大约是每小时一次）。
        </div>
      </div>

      <div style={group}>
        <div style={rowTitle}>现在</div>
        <div style={card}>
          <div style={kv}>
            <span style={{ opacity: 0.6 }}>刚才看见</span>
            <span>{st?.title ? `${st.title}` : '还没看过'}</span>
          </div>
          <div style={kv}>
            <span style={{ opacity: 0.6 }}>看的时间</span>
            <span>{snap ? ago(st?.lastAt ?? 0, snap.now) : '—'}</span>
          </div>
          <div style={kv}>
            <span style={{ opacity: 0.6 }}>今天</span>
            <span>{st?.today ?? 0} 次</span>
          </div>
          <div style={kv}>
            <span style={{ opacity: 0.6 }}>下一次</span>
            <span>
              {st?.inMinutes ? `约 ${st.inMinutes} 分钟后` : '随时'}
              {st?.everyMinutes ? `（当前节奏 ${st.everyMinutes} 分钟${st.night ? '，深夜' : ''}）` : ''}
            </span>
          </div>
          {st && st.fails > 0 ? (
            <div style={kv}>
              <span style={{ opacity: 0.6 }}>状态</span>
              <span style={{ color: '#d08a3a' }}>连续失败 {st.fails} 次，正在退避</span>
            </div>
          ) : null}
        </div>
      </div>

      {error ? <div style={{ color: '#d0563a', fontSize: 12 }}>{error}</div> : null}
    </div>
  )
}
