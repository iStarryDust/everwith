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
      console.warn('[spoon-companion] 会话对象上没有 prompt 方法')
    } catch (error) {
      console.warn('[spoon-companion] 调 prompt 失败', error)
    }
    return false
  }

  // 麦克风按钮：挂在输入框右侧，排在朗读按钮（order 80）左边
  try {
    ctx.effect(() => {
      const style = document.createElement('style')
      style.dataset.plugin = 'spoon-companion-mic'
      style.textContent = MIC_CSS
      document.head.appendChild(style)
      return () => {
        style.remove()
      }
    }, 'spoon-companion: mic styles')

    ctx.slots.inject('conversation.input.right', () =>
      ctx.slots.register(
        {
          name: 'conversation.input.right',
          id: 'spoon-companion-mic',
          order: 70,
        },
        (props: Record<string, unknown>) => VoiceButton({ ...props, send }) as never,
      ),
    )
  } catch {
    /* 挂不上就只是没有按钮 */
  }

  // 设置 → 单独一列：看屏幕的开关和节奏
  try {
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'spoon-companion-screen',
          order: 60,
          label: 'Spoon 陪伴',
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
