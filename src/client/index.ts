/**
 * 客户端入口 —— 三块拼在一起。
 *
 *   cleanup   擦掉 <!--more--> 标记、隐藏「收到执行请求」
 *   voice     朗读按钮、设置行、流式播放（用插件自己的 MiMo / DeepSeek）
 *   mic       点一下开始听，说完自动发送（本地 sherpa-onnx 识别）
 *
 * 语音输入的"发送"不走 DOM：DSH 的会话对象上有 prompt()，
 * 直接调它比模拟回车可靠得多（合成键盘事件 isTrusted 是 false，会被忽略）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

import { applyCleanup } from './cleanup.js'
import { apply as applyVoice } from './voice/index.ts'
import { MIC_CSS, VoiceButton } from './mic.tsx'
import { ScreenSettingsSection } from './screen-settings.tsx'
import { RememberAction } from './remember-action'

export const inject = ['slots', 'sessions']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.input.right': {
      kind: 'list'
      scope: 'session'
      owner: Record<string, never>
    }
    /** 设置左侧那一列的条目 */
    'settings.section': {
      kind: 'list'
      scope: 'root'
      owner: Record<string, never>
    }
  }
}

/** 会被注入进来的会话服务。形状按 dsh-voice-mode 的用法推断。 */
interface SessionBinding {
  session?: {
    prompt?: (blocks: Array<{ type: string; text: string }>, mode?: string) => Promise<unknown>
  }
}

interface SessionService {
  binding?: (id: string) => SessionBinding | undefined
}

export function apply(ctx: Context): void {
  // 界面打扫：失败不拖累别的
  try {
    applyCleanup(ctx)
  } catch {
    /* ignore */
  }

  const sessions = (ctx as unknown as { sessions?: SessionService }).sessions

  /**
   * 直接交给 DSH 发消息。
   * @returns 成功与否；失败时组件会退回 DOM 方式
   */
  const send = async (sessionId: string, text: string): Promise<boolean> => {
    if (!sessionId) return false
    try {
      const binding = sessions?.binding?.(sessionId)
      const session = binding?.session
      if (typeof session?.prompt === 'function') {
        await session.prompt([{ type: 'text', text }], 'steer')
        return true
      }
      console.warn('[everwith] 会话对象上没有 prompt 方法')
    } catch (error) {
      console.warn('[everwith] 调 prompt 失败', error)
    }
    return false
  }

  // 麦克风按钮：挂在输入框右侧，排在朗读按钮（order 80）左边
  try {
    ctx.effect(() => {
      const style = document.createElement('style')
      style.dataset.plugin = 'everwith-mic'
      style.textContent = MIC_CSS
      document.head.appendChild(style)
      return () => {
        style.remove()
      }
    }, 'everwith: mic styles')

    ctx.slots.inject('conversation.input.right', () =>
      ctx.slots.register(
        {
          name: 'conversation.input.right',
          id: 'everwith-mic',
          order: 70,
        },
        (props: Record<string, unknown>) => VoiceButton({ ...props, send }) as never,
      ),
    )
  } catch {
    /* 挂不上就只是没有按钮 */
  }

  // 聊天消息动作行：把最近聊的记进长期记忆
  // 组件自带三层兜底(useChat 守卫 / try-catch / 空列表),拿不到宿主注入时按钮不出现,不影响页面。
  try {
    ctx.slots.inject('conversation.chat.assistant-actions', () =>
      ctx.slots.register(
        {
          name: 'conversation.chat.assistant-actions',
          id: 'everwith-remember',
          order: 20,
        },
        RememberAction as never,
      ),
    )
  } catch {
    /* 挂不上就只是没有这个按钮 */
  }

  // 设置 → 单独一列：看屏幕的开关和节奏
  try {
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'everwith-screen',
          order: 60,
          label: '常伴',
        },
        ScreenSettingsSection as never,
      ),
    )
  } catch {
    /* 挂不上就只是没有设置页 */
  }

  // 朗读：它自己会注册按钮和设置行
  applyVoice(ctx)
}
