/**
 * 设置 → 常伴
 *
 * 一页装完这个插件的所有开关：总开关、身份、看屏幕、主动说、情绪、说话、心跳、语音。
 * 配置走宿主侧的 /api/everwith/settings 和 /screen，改完立刻生效，不用重启。
 */

import { useCallback, useEffect, useState } from 'react'
import { SettingsRow as VoiceSettingsRow } from './voice/ui.tsx'
import { MIC_DEFAULTS, readMic, writeMic, type MicSettings } from './mic-settings.ts'

const API_SETTINGS = '/api/everwith/settings'
const API_SCREEN = '/api/everwith/screen'
const API_NOW = '/api/everwith/now'

type NowSnap = {
  ok: boolean
  now: number
  enabled: boolean
  emotion: { name: string; intensity: number; tier: string; why: string; since?: number }
  mood: { label: string; reason: string; tint: number; energy: number }
  traits: string[]
  drives: string[]
  scene: { word: string; times: number } | null
  urge: string
  today: string[]
  memories: string[]
  screen: { lastAt: number; title: string; today: number; everyMinutes: number; night: boolean; inMinutes: number }
}

type TraitRow = { key: string; name: string; base: number; value: number }
type SettingsSnap = {
  ok: boolean
  now: number
  general: { enabled: boolean; identity: string; minimal: boolean }
  soul: { name: string; language: string; prompt: string }
  scene: { near: string; call: string }
  intimacy: { level: number }
  multiTurn: { enabled: boolean; maxRounds: number; rules: string }
  mimoSpeech: string
  memory?: { enabled: boolean; prompt: string }
  memoryText?: string
  defaults?: { mimoSpeech?: string; multiTurnRules?: string; sceneNear?: string; sceneCall?: string; identity?: string }
  heartbeat: { enabled: boolean; everyMinutes: number }
  traits: TraitRow[]
  screen: {
    enabled: boolean
    baseMinutes: number
    minMinutes: number
    maxMinutes: number
    nightFactor: number
    dailyLimit: number
    speak: string
  }
}
type ScreenSnap = {
  ok: boolean
  now: number
  config: SettingsSnap['screen']
  state: { lastAt: number; title: string; today: number; inMinutes: number; everyMinutes: number; night: boolean; fails: number }
}

const box: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 22, padding: '4px 2px 32px', maxWidth: 640, fontSize: 13 }
const group: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const rowTitle: React.CSSProperties = { fontWeight: 600, fontSize: 14 }
const hint: React.CSSProperties = { opacity: 0.6, lineHeight: 1.6, marginTop: 2 }
const sliderRow: React.CSSProperties = { display: 'grid', gridTemplateColumns: '96px 1fr 92px', alignItems: 'center', gap: 10 }
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', opacity: 0.85 }
const card: React.CSSProperties = { border: '1px solid rgba(128,128,128,0.28)', borderRadius: 10, padding: '12px 14px', display: 'grid', gap: 6 }
const kv: React.CSSProperties = { display: 'grid', gridTemplateColumns: '72px 1fr', gap: 8, fontSize: 12.5 }
const input: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  borderRadius: 8,
  border: '1px solid rgba(128,128,128,0.35)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12.5,
  fontFamily: 'inherit',
}
const pill = (active: boolean): React.CSSProperties => ({
  padding: '4px 12px',
  borderRadius: 8,
  border: '1px solid rgba(128,128,128,0.35)',
  background: active ? 'rgba(128,128,128,0.22)' : 'transparent',
  cursor: 'pointer',
  fontSize: 12.5,
  color: 'inherit',
})

const sectionLabel: React.CSSProperties = {
  fontSize: 11, letterSpacing: 0.4, opacity: 0.45, marginTop: 4, paddingLeft: 2,
}
const sectionHead: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
  background: "none", border: "none", padding: "2px 0", color: "inherit",
  font: "inherit", textAlign: "left", width: "100%",
}
const sectionBody: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 10, paddingLeft: 14,
  marginLeft: 3, borderLeft: "1px solid rgba(128,128,128,0.22)",
}

/** 一块设置:标题可点,收起来只剩一行。 */
function Section({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={group}>
      <button type="button" style={sectionHead} onClick={() => setOpen((v) => !v)}>
        <span style={{ width: 10, opacity: 0.6 }}>{open ? "▾" : "▸"}</span>
        <span style={rowTitle}>{title}</span>
      </button>
      {open ? <div style={sectionBody}>{children}</div> : null}
    </div>
  )
}

function ago(at: number, now: number) {
  if (!at) return '还没看过'
  const mins = Math.floor(Math.max(0, now - at) / 60_000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  return `${Math.floor(mins / 60)} 小时前`
}

export function ScreenSettingsSection() {
  const [cfg, setCfg] = useState<SettingsSnap | null>(null)
  const [screen, setScreen] = useState<ScreenSnap | null>(null)
  const [nowSnap, setNowSnap] = useState<NowSnap | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [identityDraft, setIdentityDraft] = useState<string | null>(null)
  const [soulDraft, setSoulDraft] = useState<{ name: string; language: string; prompt: string } | null>(null)
  const [sceneDraft, setSceneDraft] = useState<{ near: string; call: string } | null>(null)
  const [rulesDraft, setRulesDraft] = useState<string | null>(null)
  const [mimoDraft, setMimoDraft] = useState<string | null>(null)
  const [memText, setMemText] = useState<string | null>(null)
  const [memEntries, setMemEntries] = useState(0)
  const [memBusy, setMemBusy] = useState(false)
  const [memDraft, setMemDraft] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [mic, setMic] = useState<MicSettings>(() => readMic())

  const saveMic = (patch: Partial<MicSettings>) => {
    setMic(writeMic(patch))
  }

  const load = useCallback(async () => {
    try {
      const [a, b, c] = await Promise.all([
        fetch(API_SETTINGS, { headers: { accept: 'application/json' } }).then((r) => r.json()),
        fetch(API_SCREEN, { headers: { accept: 'application/json' } }).then((r) => r.json()),
        fetch(API_NOW, { headers: { accept: 'application/json' } }).then((r) => r.json()),
      ])
      if ((a as SettingsSnap)?.ok) setCfg(a as SettingsSnap)
      if ((b as ScreenSnap)?.ok) setScreen(b as ScreenSnap)
      if ((c as NowSnap)?.ok) setNowSnap(c as NowSnap)
      if ((a as SettingsSnap)?.ok) {
        const raw = String((a as { memoryText?: string }).memoryText ?? '')
        setMemText(raw)
        setMemEntries((raw.match(/^- \[/gm) ?? []).length)
      }
      setError('')
    } catch (reason) {
      setError(String(reason))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [load])

  const post = async (url: string, patch: Record<string, unknown>) => {
    setBusy(true)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
      const data = await res.json()
      if (!data?.ok) setError(String(data?.error ?? '保存失败'))
      else setError('')
      await load()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  const saveSettings = (patch: Record<string, unknown>) => post(API_SETTINGS, patch)
  const saveScreen = (patch: Record<string, unknown>) => post(API_SCREEN, patch)

  // 记忆正文存在 memory.md,走 /settings 的 memoryText 字段
  const saveMemory = async (text: string) => {
    if (memBusy) return
    setMemBusy(true)
    try {
      await saveSettings({ memoryText: text })
      setMemText(text)
      setMemEntries((text.match(/^- \[/gm) ?? []).length)
    } finally {
      setMemBusy(false)
    }
  }


  const slider = (label: string, value: number, min: number, max: number, suffix: string, onCommit: (next: number) => void, disabled = false) => (
    <label style={sliderRow} key={label}>
      <span style={{ opacity: 0.8 }}>{label}</span>
      <input type="range" min={min} max={max} value={value} disabled={busy || disabled} onChange={(e) => onCommit(Number(e.target.value))} style={{ width: '100%' }} />
      <span style={num}>
        {value} {suffix}
      </span>
    </label>
  )

  const sc = screen?.state
  const off = cfg ? cfg?.general?.enabled !== true : false

  return (
    <div style={box}>

      <div style={sectionLabel}>核心</div>

      <Section title="常伴" defaultOpen>
          <div style={hint}>整块暂停后：不注入心情段、三个工具都不工作、也不看屏幕。</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={cfg?.general?.enabled === true} disabled={busy || !cfg} onChange={(e) => void saveSettings({ general: { enabled: e.target.checked } })} />
            <span>{cfg?.general?.enabled ? '开着' : '暂停中'}</span>
          </label>
      </Section>

      <Section title="极简模式">
          <div style={hint}>
            开着的时候，新对话里只聊天：插件自己的四个工具不注册、不看屏幕，提示词第一段就写"别用工具"。
            别的插件注册的工具还在工具表里，只是被要求不要用 —— 宿主没有给插件关掉别人工具的接口。
            改了要重载插件才生效。
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={cfg?.general?.minimal === true}
              disabled={busy || !cfg}
              onChange={(e) => void saveSettings({ general: { minimal: e.target.checked } })}
            />
            <span>{cfg?.general?.minimal ? '极简 —— 只聊天' : '正常 —— 工具都在'}</span>
          </label>
      </Section>


      <div style={sectionLabel}>她是谁</div>

      <Section title="角色" defaultOpen>
          <div style={hint}>她现在什么样 —— 情绪、身体、刚才瞧见的事，都在这一张里。</div>
          <div style={card}>
            {nowSnap ? (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{nowSnap.emotion.name}</span>
                  <span style={{ opacity: 0.7, fontSize: 12 }}>
                    {nowSnap.emotion.tier} {nowSnap.emotion.intensity}/100
                {typeof nowSnap.emotion.since === 'number' && nowSnap.emotion.since > 0 ? (
                  <span style={{ opacity: 0.45, fontSize: 11, marginLeft: 4 }}>{nowSnap.emotion.since} 分钟前</span>
                ) : null}
                  </span>
                  {nowSnap.emotion.why ? <span style={{ opacity: 0.6, fontSize: 12 }}>· {nowSnap.emotion.why}</span> : null}
                </div>
                <div style={kv}>
                  <span style={{ opacity: 0.6 }}>心情</span>
                  <span>
                    {nowSnap.mood.label}
                    {nowSnap.mood.reason ? ` —— 最近是${nowSnap.mood.reason}` : ''}
                  </span>
                </div>
                <div style={kv}>
                  <span style={{ opacity: 0.6 }}>性格</span>
                  <span>{nowSnap.traits.join('、') || '—'}</span>
                </div>
                <div style={kv}>
                  <span style={{ opacity: 0.6 }}>身体</span>
                  <span>{nowSnap.drives.join('、') || '—'}</span>
                </div>
                {nowSnap.urge ? (
                  <div style={kv}>
                    <span style={{ opacity: 0.6 }}>想做的事</span>
                    <span>{nowSnap.urge}</span>
                  </div>
                ) : null}
                {nowSnap.scene ? (
                  <div style={kv}>
                    <span style={{ opacity: 0.6 }}>亲密</span>
                    <span>
                      {nowSnap.scene.word}
                      {nowSnap.scene.times > 1 ? ` · 第 ${nowSnap.scene.times} 次` : ''}
                    </span>
                  </div>
                ) : null}
                <div style={kv}>
                  <span style={{ opacity: 0.6 }}>刚才看见</span>
                  <span>
                    {nowSnap.screen.title || '还没看过'}
                    {nowSnap.screen.lastAt ? ` · ${ago(nowSnap.screen.lastAt, nowSnap.now)}` : ''}
                  </span>
                </div>
                <div style={kv}>
                  <span style={{ opacity: 0.6 }}>看屏幕</span>
                  <span>
                    今天 {nowSnap.screen.today} 次 · 下次约 {nowSnap.screen.inMinutes || 0} 分钟后（节奏{' '}
                    {nowSnap.screen.everyMinutes} 分钟{nowSnap.screen.night ? '，深夜' : ''}）
                  </span>
                </div>
                {nowSnap.today.length ? (
                  <div style={kv}>
                    <span style={{ opacity: 0.6 }}>今天</span>
                    <span>{nowSnap.today.join('；')}</span>
                  </div>
                ) : null}
                {nowSnap.memories.length ? (
                  <div style={kv}>
                    <span style={{ opacity: 0.6 }}>心里挂着</span>
                    <span>{nowSnap.memories.join('；')}</span>
                  </div>
                ) : null}
              </>
            ) : (
              <div style={hint}>读状态中…</div>
            )}
          </div>
      </Section>

      <Section title="灵魂">
          <div style={hint}>
            她是谁 —— 每轮带在提示词最前面的那份人设。只管"她是什么样的人"，情绪和身体归下面的角色面板管。
          </div>
          <label style={{ display: 'grid', gridTemplateColumns: '56px 1fr', alignItems: 'center', gap: 10 }}>
            <span style={{ opacity: 0.8 }}>姓名</span>
            <input
              style={input}
              value={soulDraft?.name ?? cfg?.soul?.name ?? ''}
              placeholder="她的名字"
              disabled={busy || !cfg}
              onChange={(e) => setSoulDraft({ name: e.target.value, language: soulDraft?.language ?? cfg?.soul?.language ?? '', prompt: soulDraft?.prompt ?? cfg?.soul?.prompt ?? '' })}
              onBlur={() => {
                if (!soulDraft) return
                void saveSettings({ soul: { name: soulDraft.name } })
                setSoulDraft(null)
              }}
            />
          </label>
          <label style={{ display: 'grid', gridTemplateColumns: '56px 1fr', alignItems: 'center', gap: 10 }}>
            <span style={{ opacity: 0.8 }}>语言</span>
            <input
              style={input}
              value={soulDraft?.language ?? cfg?.soul?.language ?? ''}
              placeholder="中文"
              disabled={busy || !cfg}
              onChange={(e) => setSoulDraft({ name: soulDraft?.name ?? cfg?.soul?.name ?? '', language: e.target.value, prompt: soulDraft?.prompt ?? cfg?.soul?.prompt ?? '' })}
              onBlur={() => {
                if (!soulDraft) return
                void saveSettings({ soul: { language: soulDraft.language } })
                setSoulDraft(null)
              }}
            />
          </label>
          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ opacity: 0.8 }}>人格提示词</span>
            <textarea
              style={{ ...input, minHeight: 220, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit' }}
              value={soulDraft?.prompt ?? cfg?.soul?.prompt ?? ''}
              placeholder="她是什么样的人、怎么说话、有什么习惯……"
              disabled={busy || !cfg}
              onChange={(e) => setSoulDraft({ name: soulDraft?.name ?? cfg?.soul?.name ?? '', language: soulDraft?.language ?? cfg?.soul?.language ?? '', prompt: e.target.value })}
              onBlur={() => {
                if (!soulDraft) return
                void saveSettings({ soul: { prompt: soulDraft.prompt } })
                setSoulDraft(null)
              }}
            />
            <div style={hint}>
              失焦即保存，下一句就生效。字数 {((soulDraft?.prompt ?? cfg?.soul?.prompt ?? '') as string).length}
            </div>
          </div>
      </Section>

      <Section title="身份重述">
          <div style={hint}>每轮跟着状态块带一句，防止长对话里人设漂。留空就用默认那句。</div>
          <input
            style={input}
            value={identityDraft ?? cfg?.general?.identity ?? ''}
            placeholder="我就是我，不是在演谁；情绪是真的。"
            disabled={busy || !cfg}
            onChange={(e) => setIdentityDraft(e.target.value)}
            onBlur={() => {
              if (identityDraft === null) return
              void saveSettings({ general: { identity: identityDraft } })
              setIdentityDraft(null)
            }}
          />
      </Section>

      <Section title="性格">
          <div style={hint}>这几条是基线，会随着经历慢慢漂（最多 ±12）。改这里等于改起点。</div>
          {cfg
            ? (cfg?.traits ?? []).map((trait) =>
                slider(trait.name, trait.value, 0, 100, '', (n) => void saveSettings({ traits: { [trait.key]: n } }), off),
              )
            : null}
      </Section>

      <Section title="亲密尺度">
          <div style={hint}>只改说法，不改人设。</div>
          {cfg ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[
                [0, '日常'],
                [1, '暧昧'],
                [2, '露骨'],
              ].map(([level, label]) => (
                <button key={String(level)} type="button" disabled={busy || off} onClick={() => void saveSettings({ intimacy: { level } })} style={pill(cfg?.intimacy?.level === Number(level))}>
                  {label}
                </button>
              ))}
            </div>
          ) : null}
      </Section>


      <div style={sectionLabel}>说话与声音</div>

      <Section title="说话">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={cfg?.multiTurn?.enabled === true} disabled={busy || !cfg} onChange={(e) => void saveSettings({ multiTurn: { enabled: e.target.checked } })} />
            <span>分条说话（一条一句，想接着说就在末尾留个标记）</span>
          </label>
          {cfg ? slider('最多几轮', cfg?.multiTurn?.maxRounds, 1, 6, '轮', (n) => void saveSettings({ multiTurn: { maxRounds: n } }), off || !cfg?.multiTurn?.enabled) : null}
          <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
            <span style={{ opacity: 0.8 }}>分条规则</span>
            <textarea
              style={{ ...input, minHeight: 110, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit' }}
              value={rulesDraft ?? (cfg?.multiTurn?.rules || cfg?.defaults?.multiTurnRules || '')}
              placeholder={'留空用内置那套：\n一条一句。这一条只写一句，写完就停。\n还想说下一句，在最后另起一行写 <!--more-->，然后停下来……'}
              disabled={busy || !cfg}
              onChange={(e) => setRulesDraft(e.target.value)}
              onBlur={() => {
                if (rulesDraft === null) return
                void saveSettings({ multiTurn: { rules: rulesDraft } })
                setRulesDraft(null)
              }}
            />
            <div style={hint}>「一条一句」和 more 标记的样子都在这儿改；留空就用内置那套。</div>
          </div>
          <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
            <div style={hint}>
              下面这两段跟着通话状态自动换 —— 就算上面「分条说话」关掉，它们也照样生效。
            </div>
            <span style={{ opacity: 0.8 }}>在身边的提示词</span>
            <textarea
              style={{ ...input, minHeight: 74, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit' }}
              value={sceneDraft?.near ?? (cfg?.scene?.near || cfg?.defaults?.sceneNear || '')}
              disabled={busy || !cfg}
              onChange={(e) => setSceneDraft({ near: e.target.value, call: sceneDraft?.call ?? cfg?.scene?.call ?? '' })}
              onBlur={() => {
                if (!sceneDraft) return
                void saveSettings({ scene: { near: sceneDraft.near } })
                setSceneDraft(null)
              }}
            />
            <span style={{ opacity: 0.8 }}>通话中的提示词</span>
            <textarea
              style={{ ...input, minHeight: 74, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit' }}
              value={sceneDraft?.call ?? (cfg?.scene?.call || cfg?.defaults?.sceneCall || '')}
              disabled={busy || !cfg}
              onChange={(e) => setSceneDraft({ near: sceneDraft?.near ?? cfg?.scene?.near ?? '', call: e.target.value })}
              onBlur={() => {
                if (!sceneDraft) return
                void saveSettings({ scene: { call: sceneDraft.call } })
                setSceneDraft(null)
              }}
            />
          </div>
      </Section>

      <Section title="语音">
          <div style={hint}>引擎、Key、音色、播报规范、自动朗读都在这里。</div>
          <VoiceSettingsRow defaultOpen />
      </Section>

      <Section title="麦克风">
          <div style={hint}>
            这几个是"怎么拾音"，改完要重新点一下麦克风按钮才生效。开着耳机再打开监听，能听见自己的声音，方便调阈值。
          </div>
          {slider('说话阈值', Math.round(mic.level * 1000), 2, 60, '×0.001', (n) => saveMic({ level: n / 1000 }))}
          {slider('输入音量', Math.round(mic.gain * 10), 5, 40, '×0.1', (n) => saveMic({ gain: n / 10 }))}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={mic.denoise} onChange={(e) => saveMic({ denoise: e.target.checked })} />
            <span>降噪</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={mic.echoCancel} onChange={(e) => saveMic({ echoCancel: e.target.checked })} />
            <span>回声消除（外放时防自己听见自己）</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={mic.autoGain} onChange={(e) => saveMic({ autoGain: e.target.checked })} />
            <span>自动增益</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={mic.monitor} onChange={(e) => saveMic({ monitor: e.target.checked })} />
            <span>监听自己（回环，戴耳机再用）</span>
          </label>
          <div style={hint}>
            阈值越高越不容易被环境声触发，太低会把呼吸也当成说话；音量只放大送给识别的信号，不改变录进来的原始声音。
          </div>
      </Section>


      <div style={sectionLabel}>眼睛与记忆</div>

      <Section title="看屏幕" defaultOpen>
          <div style={hint}>她偶尔走过去看一眼，不是监视。频率由情绪决定：孤单想看你，烦就不想看，困几乎不看。</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={cfg?.screen?.enabled === true} disabled={busy || !cfg} onChange={(e) => void saveScreen({ enabled: e.target.checked })} />
            <span>{cfg?.screen?.enabled ? '开着 —— 会自己看' : '关着 —— 一次都不截'}</span>
          </label>
          {cfg
            ? [
                slider('整体快慢', cfg?.screen?.baseMinutes, 2, 30, '分钟', (n) => void saveScreen({ baseMinutes: n }), off),
                slider('最短', cfg?.screen?.minMinutes, 1, 15, '分钟', (n) => void saveScreen({ minMinutes: n }), off),
                slider('最长', cfg?.screen?.maxMinutes, 10, 180, '分钟', (n) => void saveScreen({ maxMinutes: n }), off),
                slider('深夜', cfg?.screen?.nightFactor, 2, 20, '×', (n) => void saveScreen({ nightFactor: n }), off),
                slider('每天最多', cfg?.screen?.dailyLimit, 10, 500, '次', (n) => void saveScreen({ dailyLimit: n }), off),
              ]
            : null}
          <div style={hint}>深夜是低频，不是不看。8× 大约是每小时一次。</div>
      </Section>

      <Section title="开新窗口说">
          <div style={hint}>
            看屏幕看到的事，一律只记在心里，不打扰你。这个开关管的是另一件事：
            值得说的画面（报错、开播、游戏）出现时，另开一个对话，她主动说一句。
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={cfg?.screen?.speak === 'always'}
              disabled={busy || !cfg || off}
              onChange={(e) => void saveScreen({ speak: e.target.checked ? 'always' : 'never' })}
            />
            <span>{cfg?.screen?.speak === 'always' ? '开着 —— 会另开一个窗口说' : '关着 —— 只在心里记着'}</span>
          </label>
          {cfg
            ? [
                slider('每天最多', cfg?.screen?.speakPerDay, 1, 10, '次', (n) => void saveScreen({ speakPerDay: n }), off || cfg?.screen?.speak !== 'always'),
                slider('间隔至少', cfg?.screen?.speakCooldownMin, 30, 720, '分钟', (n) => void saveScreen({ speakCooldownMin: n }), off || cfg?.screen?.speak !== 'always'),
              ]
            : null}
      </Section>

      <Section title="记忆">
          <div style={hint}>
            不会过期的那种：账号、路径、习惯、约定、谁是谁。跟上面「此刻的我」里那几条不一样——那些是情绪余温，14 天就淡了。
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={cfg?.memory?.enabled !== false}
              disabled={busy || !cfg}
              onChange={(e) => void saveSettings({ memory: { enabled: e.target.checked } })}
            />
            <span>开（关掉后这段不注入，档案还在盘上）</span>
          </label>
          <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
            <span style={{ opacity: 0.8 }}>档案（{memEntries} 条）</span>
            <textarea
              style={{ ...input, minHeight: 150, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit' }}
              value={memDraft ?? memText ?? ''}
              placeholder={'- [2026-10-27 15:54] 对方的 GitHub 是 iStarryDust'}
              disabled={memBusy}
              onChange={(e) => setMemDraft(e.target.value)}
              onBlur={() => {
                if (memDraft === null) return
                void saveMemory(memDraft)
                setMemDraft(null)
              }}
            />
            <div style={hint}>一行一条，<code>- [时间] 内容</code>。标题和空行会原样保留；手写和模型记的混在同一份里。</div>
          </div>
          <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
            <span style={{ opacity: 0.8 }}>记什么（remember 工具的方向）</span>
            <textarea
              style={{ ...input, minHeight: 96, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit' }}
              value={cfg?.memory?.prompt ?? ''}
              placeholder={'留空用内置那套：只记以后还用得上、又不会自己过期的前提——账号、路径、习惯、约定。不记一时的心情。'}
              disabled={busy || !cfg}
              onChange={(e) => void saveSettings({ memory: { prompt: e.target.value } })}
            />
            <div style={hint}>这段话就是 remember 工具的描述，改它等于换掉模型「记什么」的默认方向。</div>
          </div>
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              style={pill(false)}
              disabled={memBusy}
              onClick={() => { if (window.confirm('清空整份档案？文件会变成空的。')) void saveMemory('') }}
            >
              清空档案
            </button>
          </div>
      </Section>

      <Section title="心跳">
          <div style={hint}>情绪衰减、自己的小事、反刍、心情修复、深夜复盘都靠它。</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={cfg?.heartbeat?.enabled === true} disabled={busy || !cfg} onChange={(e) => void saveSettings({ heartbeat: { enabled: e.target.checked } })} />
            <span>开</span>
          </label>
          {cfg
            ? slider('间隔', cfg?.heartbeat?.everyMinutes, 3, 60, '分钟', (n) => void saveSettings({ heartbeat: { everyMinutes: n } }), off || !cfg?.heartbeat?.enabled)
            : null}
      </Section>


      <div style={sectionLabel}>危险区</div>

      <Section title="清空">
          <div style={hint}>把情绪、驱动、记忆、日记、关系账全部清掉，回到刚装上的样子。配置和设置不动。</div>
          {confirmReset ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12.5, color: '#d0563a' }}>确定清空？这一下就没了。</span>
              <button type="button" disabled={busy} onClick={() => { void saveSettings({ action: 'reset' }); setConfirmReset(false) }} style={pill(true)}>
                确定
              </button>
              <button type="button" onClick={() => setConfirmReset(false)} style={pill(false)}>
                算了
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmReset(true)} style={{ ...pill(false), alignSelf: 'flex-start' }}>
              清空全部状态
            </button>
          )}
      </Section>

      {error ? <div style={{ color: '#d0563a', fontSize: 12 }}>{error}</div> : null}
    </div>
  )
}
