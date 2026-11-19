// 把 dsh-everwith 装进 DSH profile(幂等,可重复执行)。
//
// 做两件事:
//   1. pnpm add link:<本包目录>  —— link 协议 = 软链,改工作区里的代码即改插件,不用重装;
//   2. profile package.json 的 dsh.profile.bundles 里加上 dsh-everwith(插件的 cordis.patch.yml 负责插行)。
//
// 用法: node tools/install.mjs [--profile-dir <path>] [--no-pnpm] [--check]
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'dsh-everwith'

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const PROFILE_DIR = resolve(argOf('profile-dir', process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'desktop')))
const CHECK_ONLY = args.includes('--check')
const SKIP_PNPM = args.includes('--no-pnpm')

const pkgJsonPath = join(PROFILE_DIR, 'package.json')
if (!existsSync(pkgJsonPath)) {
  console.error(`找不到 ${pkgJsonPath} —— 用 --profile-dir 指定 DSH profile 目录`)
  process.exit(1)
}

/** 找 pnpm:PATH 里有就用;没有就退回 DSH 自带的那个(node <pnpm.mjs>) */
function resolvePnpm() {
  const explicit = argOf('pnpm', '')
  if (explicit) return { cmd: process.execPath, args: [explicit] }
  const probe = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: true })
  if (probe.status === 0) return { cmd: 'pnpm', args: [] }
  const bundled = join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
  if (existsSync(bundled)) return { cmd: process.execPath, args: [bundled] }
  return null
}

/** 1) 依赖:pnpm add link:<包目录> */
function ensureDependency() {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  const current = pkg.dependencies?.[PACKAGE_NAME] ?? ''
  const wanted = `link:${PACKAGE_DIR}`
  // pnpm 写回去的路径用正斜杠,比对时统一一下,不然 --check 永远说「期望…」
  const norm = (value) => String(value).replace(/\\/g, '/').toLowerCase()
  if (norm(current) === norm(wanted)) return `已装(${current})`
  if (CHECK_ONLY) return current ? `依赖是 ${current},期望 ${wanted}` : '未安装'
  if (SKIP_PNPM) return '跳过 pnpm(--no-pnpm)'
  const pnpm = resolvePnpm()
  if (!pnpm) {
    console.error('找不到 pnpm(PATH 里没有,DSH 自带的也没找到)—— 用 --pnpm <pnpm.mjs 路径> 指定')
    process.exit(2)
  }
  const result = spawnSync(pnpm.cmd, [...pnpm.args, 'add', wanted], { cwd: PROFILE_DIR, encoding: 'utf8', shell: pnpm.cmd === 'pnpm' })
  if (result.status !== 0) {
    console.error('pnpm add 失败:\n' + (result.stdout ?? '') + (result.stderr ?? ''))
    process.exit(2)
  }
  return `已安装(${wanted})`
}

/** 2) bundles 列表:加上包名 */
function ensureBundle() {
  const raw = readFileSync(pkgJsonPath, 'utf8')
  const pkg = JSON.parse(raw)
  pkg.dsh = pkg.dsh ?? {}
  pkg.dsh.profile = pkg.dsh.profile ?? {}
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  if (bundles.includes(PACKAGE_NAME)) return '已在 bundles 里'
  if (CHECK_ONLY) return 'bundles 里没有它'
  bundles.push(PACKAGE_NAME)
  pkg.dsh.profile.bundles = bundles
  copyFileSync(pkgJsonPath, pkgJsonPath + '.pre-everwith.bak')
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n')
  return '已加入 bundles(原文件备份 .pre-everwith.bak)'
}

console.log(`profile : ${PROFILE_DIR}`)
console.log(`插件包  : ${PACKAGE_DIR}`)
console.log(`1. 依赖  : ${ensureDependency()}`)
console.log(`2. bundle: ${ensureBundle()}`)
if (CHECK_ONLY) {
  console.log('\n(--check 只检查,不改动)')
} else {
  console.log('\n下一步:')
  console.log('  · 重启 DSH(或等热重载)后,新会话里会出现 mood_now / mood_feel / mood_diary;')
  console.log('  · 用 node tools/probe-mood.mjs 确认工具和提示词段真的加载了;')
  console.log('  · 在群里让她「说说你现在什么心情」,或者自己 mood_feel 记一笔试试。')
  console.log('  · 不想要了:profile 的 package.json 里删掉这一行 + bundles 里那一项。')
}
