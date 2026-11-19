/**
 * 麦克风的浏览器端参数。
 *
 * 这些是「这台机器上怎么拾音」的问题，跟情绪账本没关系，所以存 localStorage，
 * 不走宿主。改完要重新开一次麦克风才生效（按钮再点一下）。
 */

export type MicSettings = {
  /** 说话判定阈值：rms 超过它就算在说话（0.002 – 0.06） */
  level: number
  /** 输入增益（0.5 – 4） */
  gain: number
  /** 降噪 */
  denoise: boolean
  /** 回声消除（外放时防止自己听见自己） */
  echoCancel: boolean
  /** 自动增益 */
  autoGain: boolean
  /** 监听自己：把麦克风的声音直接放出来，用来调阈值和增益 */
  monitor: boolean
}

const KEY = 'everwith:mic'

export const MIC_DEFAULTS: MicSettings = {
  level: 0.008,
  gain: 1,
  denoise: true,
  echoCancel: true,
  autoGain: true,
  monitor: false,
}

export function readMic(): MicSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...MIC_DEFAULTS }
    const saved = JSON.parse(raw) as Partial<MicSettings>
    const next = { ...MIC_DEFAULTS, ...saved }
    next.level = Math.max(0.002, Math.min(0.06, Number(next.level) || MIC_DEFAULTS.level))
    next.gain = Math.max(0.5, Math.min(4, Number(next.gain) || 1))
    return next
  } catch {
    return { ...MIC_DEFAULTS }
  }
}

export function writeMic(patch: Partial<MicSettings>): MicSettings {
  const next = { ...readMic(), ...patch }
  next.level = Math.max(0.002, Math.min(0.06, Number(next.level) || MIC_DEFAULTS.level))
  next.gain = Math.max(0.5, Math.min(4, Number(next.gain) || 1))
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* 存不进去就只在内存里生效，不影响这次录音 */
  }
  return next
}
