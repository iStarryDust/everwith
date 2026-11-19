/**
 * 构建客户端半边。
 *
 *   src/client/index.ts  →  lib/client.js（浏览器，CJS + __ModuleLoader__ 包装）
 *
 * 约定（与 dsh-client-modules 的加载契约一致）：
 *   - bundle id 必须严格等于 package.json 的包名
 *   - @deepseek-ai/* 一律 external（运行时由 dsh 提供，绝不能打第二份）
 *
 * 宿主半边不走 esbuild：plugin.js 和 lib/*.js 都是手写/搬来的 ESM，直接跑。
 * 例外是 lib/voice.js —— 那是语音宿主的编译产物（只依赖 node: 内置模块），
 * 原始 TS 在 src/voice-host/ 下，要改就改那边，再用 voice 仓库的 build.mjs 重新出。
 */
import { build } from 'esbuild'
import { readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
mkdirSync(root + 'lib', { recursive: true })
const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'))

const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-renderer/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-chat/client',
  '@deepseek-ai/dsh-client-ui-conversation/client',
]

const result = await build({
  entryPoints: [root + 'src/client/index.ts'],
  outfile: root + 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  sourcemap: true,
  logLevel: 'warning',
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    js:
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\n` +
      'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
})

if (result.errors.length > 0) process.exit(1)
console.log(`client bundle -> lib/client.js (id=${pkg.name})`)
