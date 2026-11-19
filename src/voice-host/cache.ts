/**
 * 音频缓存：文本 → wav 文件，文件名就是内容哈希。
 *
 * 设计要点：
 *   - **文件名即索引**：`<sha1(引擎|音色|风格|正文)>.wav`，存在即命中，不需要额外索引文件
 *   - **命中就零成本**：同一句话重复点播不再调 API，省时间也省钱
 *   - **有界**：总量上限 + 单条过期 + 手动清空，三层兜底，不会无限膨胀
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 总量上限（字节）。超出后按最久未使用回收到低水位。 */
const MAX_BYTES = 200 * 1024 * 1024
/** 回收目标（字节），避免反复触发。 */
const LOW_WATER = 160 * 1024 * 1024
/** 单条最长保留（毫秒）。 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** 缓存目录（由调用方注入，通常是 home()/audio）。 */
let cacheDir = ''

/** 设置缓存目录并确保存在。 */
export function initCache(dir: string): void {
  cacheDir = dir
  mkdirSync(dir, { recursive: true })
}

/** 由内容算缓存 key。 */
export function cacheKey(parts: {
  engine: string
  voice: string
  style: string
  text: string
}): string {
  return createHash('sha1')
    .update(`${parts.engine}|${parts.voice}|${parts.style}|${parts.text}`)
    .digest('hex')
    .slice(0, 16)
}

/** 取缓存文件绝对路径。 */
export function cachePath(key: string): string {
  return join(cacheDir, `${key}.wav`)
}

/** 命中则返回路径并刷新访问时间，未命中返回 undefined。 */
export function lookupCache(key: string): string | undefined {
  if (!cacheDir || !/^[0-9a-f]{16}$/.test(key)) return undefined
  const file = cachePath(key)
  if (!existsSync(file)) return undefined
  // 刷新 mtime，让 LRU 认为它"刚用过"
  try {
    const now = new Date()
    utimesSync(file, now, now)
  } catch {
    /* 只读文件系统等情况忽略 */
  }
  return file
}

/** 写入缓存（覆盖同名文件）。 */
export function writeCache(key: string, wav: Buffer): void {
  if (!cacheDir || !/^[0-9a-f]{16}$/.test(key)) return
  try {
    // 用随机名先写再改名，避免读到写一半的文件
    const tmp = join(cacheDir, `.${key}.${Date.now()}.tmp`)
    writeFileSync(tmp, wav)
    renameSync(tmp, cachePath(key))
  } catch {
    /* 写缓存失败不影响播放 */
  }
}

/** 统计缓存占用与条目数。 */
export function cacheStats(): { bytes: number; count: number } {
  if (!cacheDir || !existsSync(cacheDir)) return { bytes: 0, count: 0 }
  let bytes = 0
  let count = 0
  for (const name of readdirSync(cacheDir)) {
    if (!name.endsWith('.wav')) continue
    try {
      bytes += statSync(join(cacheDir, name)).size
      count++
    } catch {
      /* 并发删除可能失败，跳过 */
    }
  }
  return { bytes, count }
}

/**
 * 回收：先删过期，再按最久未使用删到低水位。
 * @returns 删掉的文件数
 */
export function pruneCache(): number {
  if (!cacheDir || !existsSync(cacheDir)) return 0
  const now = Date.now()
  const entries: Array<{ file: string; size: number; atime: number }> = []
  let removed = 0

  for (const name of readdirSync(cacheDir)) {
    const file = join(cacheDir, name)
    try {
      const st = statSync(file)
      // 过期直接删（含遗留的 .tmp）
      if (now - st.mtimeMs > MAX_AGE_MS) {
        unlinkSync(file)
        removed++
        continue
      }
      if (name.endsWith('.wav')) entries.push({ file, size: st.size, atime: st.mtimeMs })
    } catch {
      /* 跳过 */
    }
  }

  let total = entries.reduce((sum, e) => sum + e.size, 0)
  if (total <= MAX_BYTES) return removed

  // 最久未使用优先删
  entries.sort((a, b) => a.atime - b.atime)
  for (const e of entries) {
    if (total <= LOW_WATER) break
    try {
      unlinkSync(e.file)
      total -= e.size
      removed++
    } catch {
      /* 跳过 */
    }
  }
  return removed
}

/** 清空全部缓存。 */
export function clearCache(): { removed: number } {
  if (!cacheDir || !existsSync(cacheDir)) return { removed: 0 }
  let removed = 0
  for (const name of readdirSync(cacheDir)) {
    try {
      unlinkSync(join(cacheDir, name))
      removed++
    } catch {
      /* 跳过 */
    }
  }
  return { removed }
}
