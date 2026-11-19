/**
 * 界面打扫 —— 两件小事。
 *
 * 1. 把正文里的 `<!--more-->` 标记删掉。
 *    宿主用这个标记判断"这句话还没说完"，但它会作为纯文本显示出来，
 *    所以渲染后在这里擦掉。
 *
 * 2. 隐藏"收到执行请求"这类触发块。
 *    宿主用 agent.followup 续话时会投递一条非用户来源的消息，
 *    界面会给它一个「收到执行请求」的小卡片 —— 对聊天来说是噪音。
 *
 * 实现上不依赖任何 class 名：按文本内容找节点，往上找带背景色的容器。
 * 这样 DSH 改版最多让打扫失效，不会报错、不会影响功能。
 */

const MARKER = '<!--more-->'

/** 续话时会被渲染成小卡片的那些文案。 */
const TRIGGER_TEXTS = new Set([
  // 只留「一眼就知道是续话卡片」的句子。
  // 「自动化任务」「后台任务状态更新」这类通用词在侧栏、设置页也会出现,
  // 一旦撞上就会把整个侧栏隐藏掉 —— 宁可不打扫,也不能误伤。
  '收到执行请求',
  '继续执行目标',
  '收到任务消息',
  '收到团队消息',
  '子任务状态更新',
  '收到 GitHub 事件',
  '收到外部事件',
])

/** 擦掉正文里的标记，连带收拾前后的空行。 */
function stripMarkers(root) {
  let walker
  try {
    walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  } catch {
    return
  }
  const hits = []
  let node = walker.nextNode()
  while (node) {
    const v = node.nodeValue
    if (typeof v === 'string' && v.indexOf(MARKER) !== -1) hits.push(node)
    node = walker.nextNode()
  }
  for (const n of hits) {
    const cleaned = n.nodeValue
      .split(MARKER)
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, '')
    if (cleaned !== n.nodeValue) n.nodeValue = cleaned
  }
}

/** 隐藏触发块：从文案节点往上找第一个有底色的容器。 */
function hideTriggers(root) {
  let candidates
  try {
    candidates = root.querySelectorAll('span,div,p,a')
  } catch {
    return
  }
  for (const el of candidates) {
    if (el.children.length > 0) continue
    const text = (el.textContent || '').trim()
    if (!TRIGGER_TEXTS.has(text)) continue
    let p = el
    for (let depth = 0; depth < 6 && p.parentElement; depth++) {
      p = p.parentElement
      let bg = ''
      try {
        bg = getComputedStyle(p).backgroundColor
      } catch {
        break
      }
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        // 安全阀:卡片很小,侧栏/面板很高。高度超过 160px 的一律不碰,
        // 免得把装着它的整块界面一起藏了。
        let height = 0
        try {
          height = p.getBoundingClientRect().height
        } catch {
          height = 0
        }
        if (height > 160) break
        p.setAttribute('data-everwith-cleanup-hidden', '1')
        p.style.setProperty('display', 'none', 'important')
        break
      }
    }
  }
}

/** 一遍打扫。任何异常都吞掉 —— 界面问题不该影响聊天。 */
function sweep() {
  const body = document.body
  if (!body) return
  try {
    stripMarkers(body)
  } catch {
    /* ignore */
  }
  try {
    hideTriggers(body)
  } catch {
    /* ignore */
  }
}

/** 挂载：观察 DOM 变化，变化后延迟打扫一次。 */
export function applyCleanup(ctx) {
  let timer = 0
  let observer

  const schedule = () => {
    if (timer) return
    timer = window.setTimeout(() => {
      timer = 0
      sweep()
    }, 160)
  }

  try {
    observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  } catch {
    observer = undefined
  }

  schedule()
  window.setTimeout(sweep, 600)

  try {
    ctx?.effect?.(() => () => {
      if (timer) window.clearTimeout(timer)
      try {
        observer?.disconnect()
      } catch {
        /* ignore */
      }
    })
  } catch {
    /* ignore */
  }
}
