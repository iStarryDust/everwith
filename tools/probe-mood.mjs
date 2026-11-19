// 探针:确认 dsh-everwith 真的在跑,而且是**这一版**在跑。
//
// 为什么不用日志:桌面端把宿主子进程的 stdout 收走了,插件注册失败在用户侧一点痕迹都没有。
// 会话日志里的 request/header 是「模型实际看到的东西」,它才说明插件到底加载没加载;
// 账本文件说明状态机真的在写。
//
// 用法:
//   node tools/probe-mood.mjs              # 扫最近几个会话
//   node tools/probe-mood.mjs <会话日志路径>
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSION_FILE = 'session.v4.jsonl.zstd'
const WANTED = ['mood_now', 'mood_feel', 'mood_diary']

function listSessions(root, limit = 12) {
  const found = []
  const walk = (dir, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory() && depth > 0) { walk(full, depth - 1); continue }
      if (entry.name !== SESSION_FILE) continue
      try { found.push({ path: full, mtimeMs: statSync(full).mtimeMs }) } catch { /* 读不到就算了 */ }
    }
  }
  walk(root, 2)
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
}

function decompressAll(buf) {
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) offsets.push(i)
  const parts = []
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try { parts.push(zstdDecompressSync(buf.subarray(offsets[k], end))) } catch { /* 半截帧跳过 */ }
  }
  return Buffer.concat(parts).toString('utf8')
}

function readEvents(path) {
  try {
    return decompressAll(readFileSync(path)).split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean)
  } catch {
    return []
  }
}

const arg = process.argv[2]
const targets = arg
  ? [{ path: arg, mtimeMs: 0 }]
  : listSessions(join(homedir(), '.dsh', 'sessions'))
if (targets.length === 0) {
  console.error('没找到会话日志(~/.dsh/sessions 下没有 session.v4.jsonl.zstd)')
  process.exit(1)
}

// 账本:状态机真的在写吗。也用来判断提示词段到底渲染过没有 ——
// 系统提示词本身**不落会话日志**(日志里只有 request/header 的工具表),
// 所以「这一段工作过」的证据是:渲染时会把「读到哪」写进 seen。
const stateFile = join(homedir(), '.dsh', 'everwith', 'state.json')
let moodState = null
try {
  moodState = JSON.parse(readFileSync(stateFile, 'utf8'))
} catch {
  moodState = null
}
const seenIds = Object.keys(moodState?.seen ?? {})

let loaded = false
console.log(`扫描 ${targets.length} 个最近的会话日志\n`)
for (const target of targets) {
  const events = readEvents(target.path)
  if (events.length === 0) continue
  const headers = events.filter((event) => event.type === 'request/header')
  const last = headers[headers.length - 1]
  const tools = (last?.data?.header?.tools ?? []).map((tool) => tool.name)
  const hasTools = WANTED.every((name) => tools.includes(name))
  if (!hasTools && headers.length === 0) continue
  const sessionId = target.path.split(/[\\/]/).slice(-2)[0]
  const calls = events.filter((event) => event.type === 'tool/call')
  const moodCalls = calls.filter((event) => WANTED.includes(event.data?.name))
  loaded = loaded || hasTools
  console.log(`会话 ${sessionId.slice(0, 12)}  ${new Date(target.mtimeMs).toLocaleString('zh-CN', { hour12: false })}`)
  console.log(`  工具表(${tools.length} 个工具):${WANTED.map((n) => `${tools.includes(n) ? '✅' : '❌'} ${n}`).join('  ')}`)
  console.log(`  心情段渲染过:${seenIds.some((id) => id.startsWith(sessionId.slice(0, 12))) ? '✅(账本里有这个会话的「读到哪」)' : '❌ 没渲染过这个会话(渠道被 channels 关掉 / 本会话还没轮到插件 / 插件没重载)'}`)
  console.log(`  mood_* 调用:${moodCalls.length} 次${moodCalls.length ? ` — 最近:${moodCalls.at(-1).data.name}` : ''}`)
  console.log('')
}

if (moodState) {
  const mood = moodState.mood ?? {}
  console.log('账本 ~/.dsh/everwith/state.json:')
  console.log(`  现在:${mood.key}(${Math.round(mood.intensity ?? 0)})${mood.why ? ` · ${mood.why}` : ''} · 底色 ${Math.round(moodState.core?.valence ?? 0)}/${Math.round(moodState.core?.energy ?? 0)}`)
  console.log(`  日记 ${(moodState.diary ?? []).length} 条 · 关系 ${Object.keys(moodState.convs ?? {}).length} 个会话 / ${Object.keys(moodState.people ?? {}).length} 个人 · 冲量 ${moodState.stats?.impulses ?? 0} 次`)
  console.log(`  听到的会话(${seenIds.length} 个):${seenIds.map((id) => id.slice(0, 12)).join('、') || '(还没有 —— 提示词段一次都没渲染过)'}`)
  for (const row of (moodState.diary ?? []).slice(-3)) {
    console.log(`    ${new Date(row.at).toLocaleString('zh-CN', { hour12: false }).slice(5, 16)} [${row.kind}] ${row.why}`)
  }
} else {
  console.log('账本还不存在(~/.dsh/everwith/state.json)—— 插件要么没加载,要么还没跑过一轮')
}

console.log(loaded ? '\neverwith 已加载 ✅' : '\n没在任何会话里看到 mood_* 工具 —— 多半是插件没装/没重载 ❌')
process.exit(loaded ? 0 : 2)
