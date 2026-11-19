// 看屏幕：截一张全屏图，存成 JPEG，把路径交回去。
//
// 设计上的几条硬约束:
//   · 不落成"随手一堆文件" —— 只保留最近 N 张,旧的自己删。
//   · 不常驻进程、不装依赖 —— 每次 spawn 一次 powershell,截完就退。
//   · 不替调用方判断该不该看 —— 那是情绪那一层的事,这里只负责"能截到"。
//
// Windows 上用 System.Drawing + CopyFromScreen,不需要任何授权;
// macOS / Linux 直接返回 unsupported,让上层安静跳过。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 落盘目录:和情绪状态放一起,方便一起清理 */
export const SHOT_DIR = join(homedir(), '.dsh', 'fish-mood', 'shots')

/** 保留最近几张 */
const KEEP = 12

/** 截图脚本:纯 ASCII,避免编码问题。窗口标题单独写文件(UTF-8),不走 stdout。 */
const PS1 = `param([string]$Out, [int]$MaxEdge, [string]$TitleOut)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinInfo {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
$title = ''
try {
  $h = [WinInfo]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][WinInfo]::GetWindowText($h, $sb, 512)
  $title = $sb.ToString()
} catch { }
if ($TitleOut) { [System.IO.File]::WriteAllText($TitleOut, $title, (New-Object System.Text.UTF8Encoding $false)) }
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($b.Width -le 0 -or $b.Height -le 0) { throw 'no-screen' }
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$g.Dispose()
$ratio = [Math]::Min(1.0, [double]$MaxEdge / [Math]::Max($bmp.Width, $bmp.Height))
if ($ratio -lt 1.0) {
  $w = [int]($bmp.Width * $ratio)
  $h2 = [int]($bmp.Height * $ratio)
  $small = New-Object System.Drawing.Bitmap($w, $h2)
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.DrawImage($bmp, 0, 0, $w, $h2)
  $sg.Dispose()
  $bmp.Dispose()
  $bmp = $small
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Jpeg)
Write-Output ("{0}x{1}" -f $bmp.Width, $bmp.Height)
$bmp.Dispose()
`

/** Windows 自带的 powershell.exe。DSH 进程的 PATH 可能是旧的,所以写全路径。 */
const PS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** 这个平台能不能截 */
export function screenSupported() {
  return process.platform === 'win32'
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      reject(new Error('timeout'))
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error((err || out || `exit ${code}`).trim().slice(0, 300)))
    })
  })
}

/** 只留最近 KEEP 张 */
export function pruneShots() {
  try {
    if (!existsSync(SHOT_DIR)) return 0
    const rows = readdirSync(SHOT_DIR)
      .filter((name) => name.endsWith('.jpg'))
      .map((name) => ({ name, at: statSync(join(SHOT_DIR, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    let n = 0
    for (const row of rows.slice(KEEP)) {
      try { unlinkSync(join(SHOT_DIR, row.name)); n++ } catch { /* ignore */ }
    }
    return n
  } catch {
    return 0
  }
}

/**
 * 截一张。
 * @param {{ maxEdge?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ path: string, width: number, height: number, bytes: number, at: number }>}
 */
export async function capture(opts = {}) {
  if (!screenSupported()) throw new Error('unsupported-platform')
  const maxEdge = Math.max(320, Math.min(2560, Number(opts.maxEdge) || 1280))
  const timeoutMs = Math.max(2000, Math.min(20000, Number(opts.timeoutMs) || 9000))
  mkdirSync(SHOT_DIR, { recursive: true })
  const stamp = new Date()
  const name = `shot-${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}${String(stamp.getSeconds()).padStart(2, '0')}-${Math.random().toString(36).slice(2, 6)}.jpg`
  const out = join(SHOT_DIR, name)
  const ps1 = join(SHOT_DIR, '_shot.ps1')
  const titlePath = join(SHOT_DIR, '_title.txt')
  writeFileSync(ps1, PS1, 'utf8')
  try {
    const size = await run(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Out', out, '-MaxEdge', String(maxEdge), '-TitleOut', titlePath], timeoutMs)
    const [w, h] = String(size).split('x').map((n) => Number(n) || 0)
    const bytes = statSync(out).size
    let title = ''
    try { title = readFileSync(titlePath, 'utf8').trim() } catch { title = '' }
    pruneShots()
    return { path: out, width: w, height: h, bytes, at: Date.now(), title }
  } catch (error) {
    try { if (existsSync(out)) unlinkSync(out) } catch { /* ignore */ }
    throw error
  } finally {
    try { rmSync(ps1, { force: true }) } catch { /* ignore */ }
    try { rmSync(titlePath, { force: true }) } catch { /* ignore */ }
  }
}

/** 把截图读成 base64（给需要内联图片的调用方用） */
export function readShotAsBase64(path) {
  return readFileSync(path).toString('base64')
}
