/**
 * companion-voice — 浏览器半。
 *
 * 注册两个座位：
 *   conversation.chat.assistant-actions  🔊 喇叭（order 40，排在「时间」之前）
 *   settings.general.item                登录 / 会话 / 提示词
 *
 * 所有座位都用 slots.inject 等声明就绪后再注册 —— assistant-actions 由
 * conversation.chat.node 的条目挂载时声明，早注册会抛。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// type-only：把官方 SlotMap（assistant-actions / settings.general.item）带进类型程序
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CSS, SettingsRow, SpeakerButton } from './ui.tsx'
import { api, updateAutoFlags } from './api.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** 设置 → 通用的单行偏好（ui-settings-general 声明）。 */
    'settings.general.item': { kind: 'list'; scope: 'root'; owner: Record<string, never> }
  }
}

/** 必需服务：座位注册表。 */
export const inject = ['slots']

/**
 * 挂载浏览器半。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'companion-voice'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => {
      style.remove()
    }
  }, 'companion-voice: styles')

  // 自动朗读的开关必须在**任何组件挂载之前**就位。
  // 设置行只在用户打开设置页时才挂载，靠它同步的话，第一次打开应用时
  // autoFlags 还是默认的 false —— 开关看着是开的，但一条都不会自动朗读。
  ctx.effect(() => {
    let alive = true
    const sync = (): void => {
      void api
        .state()
        .then((s) => {
          if (alive) updateAutoFlags(s.enabled, s.autoPlay)
        })
        .catch(() => {
          /* 宿主没起来就算了，下一轮再说 */
        })
    }
    sync()
    const timer = window.setInterval(sync, 15_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, 'companion-voice: auto flags')

  // 喇叭：排在动作行靠前的位置（时间控件在末尾）
  ctx.slots.inject('conversation.chat.assistant-actions', () =>
    ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'companion-voice-speak', order: 40 }, SpeakerButton),
  )

  // 设置行
  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register({ name: 'settings.general.item', id: 'companion-voice-settings', order: 40 }, SettingsRow),
  )
}
