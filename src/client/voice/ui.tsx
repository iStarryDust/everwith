/**
 * 浏览器半的 UI：
 *   1) SpeakerButton —— 消息动作行的喇叭（在「时间」前面）
 *   2) SettingsRow   —— 设置 → 通用：引擎切换、Key、音色、小米风格、克隆样本
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { api, getPlayback, hasAutoPlayed, isPlaying, isStreaming, markAutoPlayed, shouldAutoPlay, speakStream, stopAll, subscribeAutoFlags, updateAutoFlags, type CvEngine, type CvStateView } from './api.ts'
import { useAssistantInfo } from './transcript.ts'

/** 消息动作行座位 props。 */
type ActionProps = PropsRuntime<'conversation.chat.assistant-actions'>

/** 插件样式（由 index.ts 注入一次）。 */
export const CSS = `
.cv-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
  padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;
  opacity:.62;transition:opacity .15s ease,background .15s ease;flex:0 0 auto}
.cv-btn:hover:not(:disabled){opacity:1;background:rgba(128,128,128,.14)}
.cv-btn:disabled{opacity:.28;cursor:default}
.cv-btn--on{opacity:1;color:#4d6bfe}
.cv-spin{display:inline-block;width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;
  border-radius:50%;animation:cv-spin .7s linear infinite}
@keyframes cv-spin{to{transform:rotate(360deg)}}
.cv-bars{display:inline-flex;align-items:flex-end;gap:2px;height:13px}
.cv-bars i{display:block;width:2.5px;border-radius:1px;background:currentColor;animation:cv-bar .9s ease-in-out infinite}
.cv-bars i:nth-child(1){height:5px;animation-delay:0s}
.cv-bars i:nth-child(2){height:12px;animation-delay:.15s}
.cv-bars i:nth-child(3){height:8px;animation-delay:.3s}
.cv-bars i:nth-child(4){height:13px;animation-delay:.45s}
@keyframes cv-bar{0%,100%{transform:scaleY(.35)}50%{transform:scaleY(1)}}

.cv-row{display:flex;align-items:center;gap:10px;width:100%;padding:2px 0}
.cv-row-main{flex:1 1 auto;min-width:0}
.cv-row-title{font-size:13px;line-height:20px}
.cv-row-desc{font-size:12px;line-height:18px;opacity:.62;margin-top:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-tag{flex:0 0 auto;font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;
  border:1px solid currentColor;opacity:.7}
.cv-tag--ok{color:#2ea043;opacity:.9}
.cv-tag--err{color:#d1242f;opacity:.9}
.cv-panel{margin-top:8px;padding:12px;border-radius:10px;background:rgba(128,128,128,.08);
  display:flex;flex-direction:column;gap:12px;font-size:12.5px;line-height:19px}
.cv-field{display:flex;flex-direction:column;gap:5px}
.cv-field label{opacity:.66;font-size:12px}
.cv-hint{font-size:11.5px;line-height:17px;opacity:.6}
.cv-input,.cv-textarea,.cv-select{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:7px;
  border:1px solid rgba(128,128,128,.34);background:rgba(255,255,255,.06);color:inherit;
  font:inherit;font-size:12.5px;outline:none}
.cv-input:focus,.cv-textarea:focus,.cv-select:focus{border-color:#4d6bfe}
.cv-textarea{resize:vertical;min-height:52px;line-height:18px}
.cv-select{cursor:pointer}
.cv-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.cv-primary{padding:5px 14px;border-radius:7px;border:0;background:#4d6bfe;color:#fff;
  font:inherit;font-size:12.5px;cursor:pointer}
.cv-primary:disabled{opacity:.5;cursor:default}
.cv-ghost{padding:5px 12px;border-radius:7px;border:1px solid rgba(128,128,128,.4);
  background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer}
.cv-ghost:disabled{opacity:.5;cursor:default}
.cv-msg{font-size:12px;line-height:18px;opacity:.8;word-break:break-all}
.cv-msg--err{color:#d1242f;opacity:1}
.cv-msg--ok{color:#2ea043;opacity:1}
.cv-seg{display:inline-flex;border:1px solid rgba(128,128,128,.34);border-radius:8px;overflow:hidden}
.cv-seg button{padding:5px 16px;border:0;background:transparent;color:inherit;font:inherit;
  font-size:12.5px;cursor:pointer;opacity:.72}
.cv-seg button+button{border-left:1px solid rgba(128,128,128,.34)}
.cv-seg button[data-on="1"]{background:#4d6bfe;color:#fff;opacity:1}
.cv-check{display:flex;align-items:center;gap:7px;cursor:pointer;user-select:none}
.cv-check input{width:14px;height:14px;cursor:pointer;accent-color:#4d6bfe}
.cv-file{display:none}

/* 全局启用开关 */
.cv-switch{display:inline-flex;align-items:center;cursor:pointer;flex:0 0 auto}
.cv-switch input{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
.cv-switch-track{position:relative;display:inline-block;width:34px;height:19px;border-radius:999px;
  background:rgba(128,128,128,.4);transition:background .18s ease}
.cv-switch-thumb{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;
  background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform .18s ease}
.cv-switch input:checked+.cv-switch-track{background:#2ea043}
.cv-switch input:checked+.cv-switch-track .cv-switch-thumb{transform:translateX(15px)}
.cv-switch input:disabled+.cv-switch-track{opacity:.45;cursor:default}
.cv-switch:hover input:not(:disabled)+.cv-switch-track{filter:brightness(1.08)}
`

/** 喇叭图标。 */
function IconSpeaker(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  )
}

/** 播放中的跳动条。 */
function PlayingBars(): JSX.Element {
  return (
    <span className="cv-bars" aria-hidden="true">
      <i /><i /><i /><i />
    </span>
  )
}

/**
 * 消息动作行里的喇叭按钮。
 * @param props - 座位 props（含 messageId 与 useChat）。
 */
export function SpeakerButton(props: ActionProps): JSX.Element {
  const info = useAssistantInfo(props.useChat, String(props.messageId))
  const [phase, setPhase] = useState<'idle' | 'busy' | 'playing'>('idle')
  const [error, setError] = useState('')
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => {
    window.clearInterval(timer.current)
  }, [])

  /* 卸载即停：切换会话 / 这条消息从列表里消失时组件会卸载，
     这正是"切走就闭嘴"的时机。只停自己播的那条，不误伤别人。 */
  useEffect(() => () => {
    if (getPlayback().messageId === String(props.messageId)) stopAll()
  }, [])

  const tick = useCallback(() => {
    // 流式和普通播放都要覆盖：两个都停了才算播完
    if (phase === 'playing' && !isPlaying() && !isStreaming()) setPhase('idle')
  }, [phase])

  useEffect(() => {
    window.clearInterval(timer.current)
    if (phase === 'playing') timer.current = window.setInterval(tick, 350)
    return () => window.clearInterval(timer.current)
  }, [phase, tick])

  /* busy 状态保底：合成最多 90 秒。超时还没进入播放就回到空闲，
     否则按钮会一直禁用，表现为"怎么点都没反应"。 */
  useEffect(() => {
    if (phase !== 'busy') return
    const t = window.setTimeout(() => {
      if (!isStreaming() && !isPlaying()) {
        setError('合成超时，请重试')
        setPhase('idle')
      }
    }, 90_000)
    return () => window.clearTimeout(t)
  }, [phase])

  const onClick = useCallback(async () => {
    if (phase === 'playing') {
      stopAll()
      setPhase('idle')
      return
    }
    if (phase === 'busy') return
    // 手动点：只播**这一条**消息自己的正文（点哪条播哪条）。
    // 注意不能用 info.latestTurnText —— 那是"最新一轮"的合并文本，
    // 点任何一条都会念最新那一轮，看起来就像"点谁都在播最新的"。
    const body = info.text.trim()
    if (!body) return
    setError('')
    setPhase('busy')
    try {
      let started = false
      await speakStream(
        body,
        { messageId: String(props.messageId), label: body, manual: true },
        {
          onStart: () => { started = true; setPhase('playing') },
          onDone: (r) => {
            // 被跳过 / 缓存命中但没触发 onStart 时，别把 UI 停在"播放中"
            if (!started && !r?.cached) setPhase('idle')
          },
          onError: (m) => { setError(m); setPhase('idle') },
        },
      )
      // 兜底：整段已结束且从未真正开始播 → 回到空闲，避免卡在 busy
      if (!started && !isStreaming() && !isPlaying()) setPhase('idle')
    } catch (e) {
      setError((e as Error).message)
      setPhase('idle')
    }
  }, [phase, info.latestTurnText, info.text, props.messageId])

  // 按钮可点性只看「这一条」有没有正文
  const readable = info.text.trim()
  const disabled = readable === '' || phase === 'busy'
  const title = error
    ? `朗读失败：${error}`
    : readable === ''
      ? '这条回复没有可朗读的正文'
      : phase === 'playing'
        ? '停止播放'
        : phase === 'busy'
          ? '正在合成…'
          : '朗读这条回复'

  /* ── 自动播放 ──
     触发条件（必须同时满足）：
       1. 我这条是「最新一轮的最后一条」（一轮只播一次）
       2. 这一轮已结束（不在流式中）
       3. 这一轮是**刚刚**结束的（turnEndedAt 距今 < FRESH_MS）
       4. 这一轮没播过（latestTurnKey 未标记）
       5. 自动播放开关是开的

     用时间窗而不是"状态跳变"的原因：
       新回复的按钮是**新挂载**的组件，永远等不到 false→true 的跳变；
       而切换历史会话时旧消息的时间戳很旧，自然被时间窗挡住。 */
  const FRESH_MS = 120_000 // 2 分钟内算"刚结束"
  const autoRef = useRef<() => void>(() => {})

  const tryAutoPlay = useCallback(() => {
    const body = info.latestTurnText.trim()
    const id = String(props.messageId)
    if (!body) return
    if (!info.isLastOfLatestTurn) return
    if (!info.settled) return
    if (!shouldAutoPlay()) return
    if (hasAutoPlayed(info.latestTurnKey)) return
    if (info.turnEndedAt > 0 && Date.now() - info.turnEndedAt > FRESH_MS) return
    if (phase !== 'idle') return
    markAutoPlayed(info.latestTurnKey)
    setError('')
    setPhase('busy')
    let started = false
    void speakStream(
      body,
      { messageId: id, label: body },
      {
        onStart: () => { started = true; setPhase('playing') },
        onDone: (r) => {
          // 被去重跳过 / 没真正开始时，回到空闲
          if (!started && !r?.cached) setPhase('idle')
        },
        onError: (m) => { setError(m); setPhase('idle') },
      },
    ).then(() => {
      if (!started && !isStreaming() && !isPlaying()) setPhase('idle')
    }).catch((e: unknown) => {
      setError((e as Error).message)
      setPhase('idle')
    })
  }, [info.latestTurnText, info.isLastOfLatestTurn, info.settled, info.latestTurnKey, info.turnEndedAt, props.messageId, phase])

  autoRef.current = tryAutoPlay

  // 开关变化：只标记"当前这轮已消费"，绝不主动播放
  useEffect(
    () =>
      subscribeAutoFlags(() => {
        if (shouldAutoPlay() && info.settled && info.latestTurnKey) {
          markAutoPlayed(info.latestTurnKey)
        }
      }),
    [info.latestTurnKey, info.settled],
  )

  /* 唯一的自动播放入口：快照变化后**等一小段安静期**再试。
     为什么要等：一轮多步骤时，正文会分几次落定，如果每次变化都立刻播，
     就会播到一半、然后又被下一段打断。等 700ms 内没有新变化，
     说明这一轮真的说完了，此时 latestTurnText 已包含全部步骤。
     去重靠 latestTurnKey（按本轮第一条消息生成，轮内不变）。 */
  useEffect(() => {
    const t = window.setTimeout(() => autoRef.current(), 700)
    return () => window.clearTimeout(t)
  }, [info.latestTurnKey, info.settled, info.latestTurnText])

  return (
    <button
      type="button"
      className={`cv-btn${phase === 'playing' ? ' cv-btn--on' : ''}`}
      onClick={() => void onClick()}
      disabled={disabled}
      title={title}
      aria-label={title}
    >
      {phase === 'busy' ? <span className="cv-spin" /> : phase === 'playing' ? <PlayingBars /> : <IconSpeaker />}
    </button>
  )
}

/**
 * 设置 → 通用 里的一行。
 */
export function SettingsRow({ defaultOpen = false }: { defaultOpen?: boolean } = {}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const [state, setState] = useState<CvStateView | undefined>(undefined)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [msgOk, setMsgOk] = useState(false)

  const [dsKeyDraft, setDsKeyDraft] = useState('')
  const [mimoKeyDraft, setMimoKeyDraft] = useState('')
  const [speechDraft, setSpeechDraft] = useState<string | null>(null)
  const [speechSaved, setSpeechSaved] = useState('')
  const [speechDefault, setSpeechDefault] = useState('')
  const [styleDraft, setStyleDraft] = useState('')
  const fileInput = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(async () => {
    try {
      const s = await api.state()
      setState(s)
      // 把全局开关状态广播给每个喇叭按钮（自动播放靠它判断）
      updateAutoFlags(s.enabled, s.autoPlay)
      setStyleDraft((prev) => (prev === '' ? s.mimo.style : prev))
    } catch (e) {
      setMsg(`读取状态失败：${(e as Error).message}`)
      setMsgOk(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => { void refresh() }, open ? 2500 : 8000)
    return () => window.clearInterval(t)
  }, [open, refresh])

  // 播报格式规范存在情绪插件那边(settings.mimoSpeech),这里直接读写
  useEffect(() => {
    let alive = true
    void fetch('/api/spoon-companion/settings', { headers: { accept: 'application/json' } })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return
        if (typeof d?.mimoSpeech === 'string') setSpeechSaved(d.mimoSpeech)
        if (typeof d?.defaults?.mimoSpeech === 'string') setSpeechDefault(d.defaults.mimoSpeech)
      })
      .catch(() => { /* 读不到就用默认 */ })
    return () => { alive = false }
  }, [])

  const saveSpeech = async (text: string) => {
    try {
      await fetch('/api/spoon-companion/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mimoSpeech: text }),
      })
      setSpeechSaved(text.trim() === speechDefault.trim() ? '' : text)
      setMsg('✓ 播报规范已保存')
      setMsgOk(true)
    } catch (e) {
      setMsg(`保存失败：${(e as Error).message}`)
      setMsgOk(false)
    }
  }

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setMsg('')
    try {
      await fn()
    } catch (e) {
      setMsg((e as Error).message)
      setMsgOk(false)
    } finally {
      setBusy('')
    }
  }, [])

  const patch = useCallback(
    (body: Record<string, unknown>, okText?: string) =>
      run('patch', async () => {
        const r = await api.config(body)
        if (!r.ok) throw new Error(r.error ?? '保存失败')
        await refresh()
        if (okText) {
          setMsg(`✓ ${okText}`)
          setMsgOk(true)
        }
      }),
    [run, refresh],
  )

  const engine: CvEngine = state?.engine ?? 'deepseek'
  const isMimo = engine === 'mimo'
  const enabled = state?.enabled ?? false
  const autoPlay = state?.autoPlay ?? false
  const cur = isMimo ? state?.mimo : state?.deepseek
  const hasKey = cur?.hasKey ?? false

  const onPickFile = useCallback(
    (file: File | undefined) => {
      if (!file) return
      void run('sample', async () => {
        const r = await api.uploadSample(file)
        if (!r.ok) throw new Error(r.error ?? '上传失败')
        await refresh()
        setMsg(`✓ 样本已上传（${(file.size / 1024).toFixed(0)} KB），已切到克隆模式`)
        setMsgOk(true)
      })
    },
    [run, refresh],
  )

  const engineName = isMimo ? '小米 MiMo' : 'DeepSeek'
  const voiceName = isMimo
    ? (state?.mimo.useClone ? '克隆音色' : (state?.mimo.voices.find((v) => v.id === state?.mimo.voice)?.name ?? '—'))
    : (state?.deepseek.voices.find((v) => v.id === state?.deepseek.voice)?.name ?? '—')

  const desc = !enabled
    ? '已关闭'
    : hasKey
      ? `${engineName} · ${voiceName}${autoPlay ? ' · 自动播放' : ''}`
      : `${engineName} · 未填 API Key`

  return (
    <div>
      <div className="cv-row">
        <div className="cv-row-main">
          <div className="cv-row-title">陪伴语音</div>
          <div className="cv-row-desc">{desc}</div>
        </div>
        {/* 全局启用开关：替代原来的「已配置」标签 */}
        <label className="cv-switch" title={enabled ? '点击关闭陪伴语音' : '点击启用陪伴语音'}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy !== ''}
            onChange={(e) => void patch({ enabled: e.target.checked }, e.target.checked ? '已启用' : '已关闭')}
          />
          <span className="cv-switch-track"><span className="cv-switch-thumb" /></span>
        </label>
        <button type="button" className="cv-ghost" onClick={() => setOpen((v) => !v)}>{open ? '收起' : '设置'}</button>
      </div>

      {open && (
        <div className="cv-panel">
          {/* 自动播放 */}
          <div className="cv-field">
            <label className="cv-check" style={{ opacity: enabled ? 1 : 0.45 }}>
              <input
                type="checkbox"
                checked={autoPlay}
                disabled={busy !== '' || !enabled}
                onChange={(e) => void patch({ autoPlay: e.target.checked }, e.target.checked ? '已开启自动播放' : '已关闭自动播放')}
              />
              <span>自动朗读新回复</span>
            </label>
            <div className="cv-hint">
              {enabled
                ? '开启后，每轮回复结束时自动朗读（手动点喇叭不受影响）。'
                : '需要先启用陪伴语音，才能开启自动播放。'}
            </div>
          </div>

          {/* 引擎切换 */}
          <div className="cv-field">
            <label>语音引擎</label>
            <div className="cv-seg">
              <button type="button" data-on={engine === 'deepseek' ? '1' : '0'} onClick={() => void patch({ engine: 'deepseek' }, '已切换到 DeepSeek')} disabled={busy !== ''}>DeepSeek</button>
              <button type="button" data-on={engine === 'mimo' ? '1' : '0'} onClick={() => void patch({ engine: 'mimo' }, '已切换到小米 MiMo（限时免费）')} disabled={busy !== ''}>小米 MiMo</button>
            </div>
            <div className="cv-hint">切换立即生效，不用保存。</div>
          </div>

          {/* Key */}
          {isMimo ? (
            <div className="cv-field">
              <label>小米 API Key（api.xiaomimimo.com 控制台获取）</label>
              <div className="cv-actions">
                <input
                  type="password"
                  className="cv-input"
                  style={{ flex: '1 1 220px' }}
                  value={mimoKeyDraft}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setMimoKeyDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && mimoKeyDraft.trim()) void patch({ mimoKey: mimoKeyDraft.trim() }, 'API Key 已保存').then(() => setMimoKeyDraft('')) }}
                  placeholder={state?.mimo.hasKey ? `已保存 · 末四位 ${state.mimo.keyTail}` : '填 MiMo API Key'}
                />
                <button type="button" className="cv-primary" onClick={() => { const k = mimoKeyDraft.trim(); if (k) void patch({ mimoKey: k }, 'API Key 已保存').then(() => setMimoKeyDraft('')) }} disabled={busy !== '' || mimoKeyDraft.trim() === ''}>保存</button>
              </div>
            </div>
          ) : (
            <div className="cv-field">
              <label>DeepSeek API Key（platform.deepseek.com 申请）</label>
              <div className="cv-actions">
                <input
                  type="password"
                  className="cv-input"
                  style={{ flex: '1 1 220px' }}
                  value={dsKeyDraft}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setDsKeyDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && dsKeyDraft.trim()) void patch({ deepseekKey: dsKeyDraft.trim() }, 'API Key 已保存').then(() => setDsKeyDraft('')) }}
                  placeholder={state?.deepseek.hasKey ? `已保存 · 末四位 ${state.deepseek.keyTail}` : 'sk-...'}
                />
                <button type="button" className="cv-primary" onClick={() => { const k = dsKeyDraft.trim(); if (k) void patch({ deepseekKey: k }, 'API Key 已保存').then(() => setDsKeyDraft('')) }} disabled={busy !== '' || dsKeyDraft.trim() === ''}>保存</button>
              </div>
            </div>
          )}

          {/* 小米专属 */}
          {isMimo && (
            <>
              <div className="cv-field">
                <label>风格指令（会作为 user 消息交给模型）</label>
                <textarea
                  className="cv-textarea"
                  value={styleDraft}
                  spellCheck={false}
                  onChange={(e) => setStyleDraft(e.target.value)}
                  onBlur={() => { if (styleDraft !== (state?.mimo.style ?? '')) void patch({ mimoStyle: styleDraft }, '风格已保存') }}
                  placeholder={state?.mimo.defaultStyle ?? '少女音，语气温柔，自然语速，气声轻微'}
                />
                <div className="cv-hint">
                  留空 = 不发送风格指令，交给服务端默认。点「清空风格」可一键清空。
                </div>
                <div className="cv-hint">
                  正文里也可以插标签：开头写 <code>(慵懒)</code>、句中插 <code>[叹气]</code>、
                  <code>[轻笑]</code>、<code>[语速加快]</code> 等，模型会照着演。
                </div>
                <div className="cv-field">
                  <label>播报格式规范（写给模型的规则，不是风格）</label>
                  <textarea
                    className="cv-textarea"
                    style={{ minHeight: 130 }}
                    value={speechDraft ?? (speechSaved || speechDefault)}
                    spellCheck={false}
                    onChange={(e) => setSpeechDraft(e.target.value)}
                    onBlur={() => {
                      if (speechDraft === null) return
                      void saveSpeech(speechDraft)
                      setSpeechDraft(null)
                    }}
                    placeholder={'留空用内置那份：\n## 语音播报格式\n只写要念出来的话，不要动作描写；用 (温柔) [轻笑] 这类标签控语气……'}
                  />
                  <div className="cv-hint">
                    只在小米通道 + 通话中注入。留空 = 用内置那份；这一条存的是「怎么写」，跟上面的风格指令是两件事。
                  </div>
                </div>
                <div className="cv-actions">
                  <button type="button" className="cv-ghost" onClick={() => { setStyleDraft(''); void patch({ mimoStyle: '' }, '已清空风格（中性自然）') }} disabled={busy !== ''}>清空风格</button>
                  <button type="button" className="cv-ghost" onClick={() => { setStyleDraft(state?.mimo.defaultStyle ?? ''); void patch({ mimoStyle: state?.mimo.defaultStyle ?? '' }, '已恢复默认风格') }} disabled={busy !== ''}>恢复默认</button>
                </div>
              </div>

              <div className="cv-field">
                <label className="cv-check">
                  <input
                    type="checkbox"
                    checked={state?.mimo.useClone ?? false}
                    onChange={(e) => void patch({ mimoUseClone: e.target.checked }, e.target.checked ? '已切到克隆音色' : '已切回预置音色')}
                    disabled={busy !== '' || !(state?.mimo.hasSample ?? false)}
                  />
                  <span>使用克隆音色（基于上传的音频样本）</span>
                </label>
                {!state?.mimo.hasSample ? <div className="cv-hint">先上传一段清晰人声（wav / mp3，≥1 秒）才能开启。</div> : null}
              </div>

              <div className="cv-field">
                <label>克隆样本</label>
                <div className="cv-actions">
                  <input
                    ref={fileInput}
                    type="file"
                    accept="audio/wav,audio/mpeg,audio/mp3,.wav,.mp3"
                    className="cv-file"
                    onChange={(e) => { onPickFile(e.target.files?.[0]); e.target.value = '' }}
                  />
                  <button type="button" className="cv-primary" onClick={() => fileInput.current?.click()} disabled={busy !== ''}>选择音频文件</button>
                  {state?.mimo.hasSample ? (
                    <>
                      <span className="cv-msg">{state.mimo.sample}</span>
                      <button type="button" className="cv-ghost" onClick={() => void run('sample', async () => { await api.clearSample(); await refresh(); setMsg('✓ 样本已删除，已切回预置音色'); setMsgOk(true) })} disabled={busy !== ''}>删除样本</button>
                    </>
                  ) : null}
                </div>
                <div className="cv-hint">克隆模式下每次合成都会把样本一起发给小米，样本不会上传到别处。</div>
              </div>

              <div className="cv-field">
                <label>预置音色{state?.mimo.useClone ? '（克隆模式下不生效）' : ''}</label>
                <select
                  className="cv-select"
                  value={state?.mimo.voice ?? '冰糖'}
                  onChange={(e) => void patch({ mimoVoice: e.target.value }, '音色已切换')}
                  disabled={busy !== '' || (state?.mimo.useClone ?? false)}
                >
                  {(state?.mimo.voices ?? []).map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          {/* DeepSeek 音色 */}
          {!isMimo && (
            <div className="cv-field">
              <label>音色</label>
              <select
                className="cv-select"
                value={state?.deepseek.voice ?? 'stella'}
                onChange={(e) => void patch({ deepseekVoice: e.target.value }, '音色已切换')}
                disabled={busy !== ''}
              >
                {(state?.deepseek.voices ?? []).map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
          )}

          {state?.lastError ? <div className="cv-msg cv-msg--err">上次错误：{state.lastError}</div> : null}
          {msg ? <div className={`cv-msg${msgOk ? ' cv-msg--ok' : ' cv-msg--err'}`}>{msg}</div> : null}

          {/* 缓存管理 */}
          <div className="cv-field">
            <label>音频缓存</label>
            <div className="cv-actions">
              <span className="cv-msg">
                {state?.cache
                  ? `${state.cache.count} 个文件 · ${(state.cache.bytes / 1048576).toFixed(1)} MB`
                  : '—'}
              </span>
              <button
                type="button"
                className="cv-ghost"
                disabled={busy !== '' || !(state?.cache?.count ?? 0)}
                onClick={() => void run('cache', async () => {
                  const r = await api.clearCache()
                  await refresh()
                  setMsg(`✓ 已清空 ${r.removed} 个文件，释放 ${(r.freedBytes / 1048576).toFixed(1)} MB`)
                  setMsgOk(true)
                })}
              >
                清空缓存
              </button>
            </div>
            <div className="cv-hint">同一句话再次朗读会直接命中缓存（零等待、零费用）。超过 200 MB 或 7 天未使用会自动回收。</div>
          </div>
        </div>
      )}
    </div>
  )
}
