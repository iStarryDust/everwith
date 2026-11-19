// 看**此刻**的心情:读运行中的账本(~/.dsh/everwith/state.json),把模型读到的那段打出来。
//
// 不连宿主、不重启,只是把同一份状态按同一套渲染函数跑一遍 ——
// 用来确认「她在群里会读到什么」,或者调完参数看看效果。
//
// 用法:
//   node tools/preview.mjs                     # 心情段 + 详细报告
//   node tools/preview.mjs --section           # 只要提示词里那一段
//   node tools/preview.mjs --conv group:XXX --person u-1
//   node tools/preview.mjs --state <state.json 路径>
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { renderMoodReport, renderMoodSection } from '../lib/prompt.js'
import { emptyState, snapshot } from '../lib/state.js'

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const stateFile = argOf('state', join(homedir(), '.dsh', 'everwith', 'state.json'))

let state = emptyState()
try {
  state = { ...state, ...JSON.parse(readFileSync(stateFile, 'utf8')) }
} catch (error) {
  console.error(`读不到账本 ${stateFile}:${error.message}`)
  console.error('(插件还没跑过一轮?先在群里跟她说句话,或者直接 mood_feel 记一笔)')
  process.exit(1)
}

// 会话/人可以手点,不点就挑账本里最近的那个
const conv = argOf('conv', '') || Object.entries(state.convs ?? {}).sort((a, b) => (b[1].lastAt ?? 0) - (a[1].lastAt ?? 0))[0]?.[0] || ''
const person = argOf('person', '') || Object.entries(state.people ?? {}).sort((a, b) => (b[1].lastAt ?? 0) - (a[1].lastAt ?? 0))[0]?.[0] || ''
const view = snapshot(state, { conv, person })

console.log(`账本:${stateFile}`)
console.log(`视角:${conv || '(没有会话)'}${person ? ` · ${person}` : ''}\n`)
if (args.includes('--section') || !args.includes('--report')) {
  console.log('──────── 模型读到的心情段 ────────')
  console.log(renderMoodSection(view))
  console.log('')
}
if (!args.includes('--section')) {
  console.log('──────── mood_now 会给她的详细版 ────────')
  console.log(renderMoodReport(view))
  console.log('')
  console.log(`(提示:这段会跟着时间自己变 —— 情绪有半衰期,底色会回归作息;` +
    `现在 ${new Date(view.now).toLocaleString('zh-CN', { hour12: false })} · ${view.clock.label})`)
}
