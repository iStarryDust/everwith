// 从会话里读「刚发生了什么」,把它翻译成**评价**,再交给评价引擎推出情绪。
//
// 这一层只做两件事:认得出「这件事大概是什么性质」,以及别把旧账翻出来。
// 它**不再直接决定情绪** —— 同样一句「你胖」,陌生人说和熟人说结果不一样,
// 她今天累不累也不一样,这些都在 lib/appraise.js 里算。
//
// 每条规则给的是评价维度(见 appraise.js 的说明),外加:
//   strength —— 这事有多大(0-1),直接进强度公式;
//   warmth   —— 顺带记一笔「这个人让她暖/凉了多少」;
//   soothe   —— 这类事不推新情绪,而是把当前的负性情绪削掉一截(道歉、哄);
//   note     —— 值得写进这个人备注的事(「叫她胖」「夸她能干」)。
//
// 触发一律**短、轻、可解释**:强度 0.35-0.85,一次最多两条,同一个群几分钟内只认一次;
// 模型永远可以用 mood_feel 覆盖它 —— 启发式只是替她把耳朵留着。
import { appraise } from './appraise.js'
import { applyImpulse, bumpRelation, remember, soothe } from './state.js'

/** 会话里的事件快照(宿主两版 Session 的字段名不同,拿不到就当空) */
export function sessionEventsOf(session) {
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events
    return Array.isArray(events) ? events : []
  } catch {
    return []
  }
}

/**
 * 这个会话是从哪儿来的?
 *
 * 判据沿用 dsh-meme / fish-feed 踩出来的那条:QQ 机器人的入站消息
 * `source: { kind: 'user' }` **没有 rpcId**,Web/桌面客户端发来的带一个裸 uuid。
 * 只看「最后一条真实用户消息」——同一个会话可能既被群里用过、又被 Web 打开过。
 */
export function channelOfSession(session, { hasQqbot = false } = {}) {
  const events = sessionEventsOf(session)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (!source || source.kind !== 'user') continue
    return typeof source.rpcId === 'string' && source.rpcId ? 'web' : 'qq'
  }
  return hasQqbot ? 'qq' : 'unknown'
}

/**
 * 把一条入站消息拆开。
 *
 * 群里长这样(见 dsh-qqbot 的 inbound.js):
 *   [Chat history begins] … [Chat history ends]
 *   [Current message]
 *   [昵称 (openid)] 内容 (@you)
 * 私聊就是光秃秃一句内容。
 */
export function parseMessage(raw) {
  let text = String(raw ?? '')
  const marker = text.lastIndexOf('[Current message]')
  if (marker >= 0) text = text.slice(marker + '[Current message]'.length)
  const mentioned = /\(@you\)\s*$/.test(text)
  text = text.replace(/\(@you\)\s*$/, '').trim()
  const hit = /^\[([^\]\n]{1,40}?)\s*\(([^)\n]{1,80})\)\]\s*/.exec(text)
  if (hit) {
    return { senderName: hit[1].trim(), senderId: hit[2].trim(), body: text.slice(hit[0].length).trim(), mentioned }
  }
  // 没有发送者标签 = 私聊:整句话都是对她说
  return { senderName: '', senderId: '', body: text.trim(), mentioned: true }
}

/** 取出会话里「还没读过」的真实用户消息(插件注入的合成消息不算) */
export function readUserMessages(session, { since = 0, limit = 6 } = {}) {
  const out = []
  for (const event of sessionEventsOf(session)) {
    if (event?.type !== 'user/message') continue
    const seq = Number(event.seq)
    if (!Number.isSafeInteger(seq) || seq <= since) continue
    const source = event.data?.source
    if (!source || source.kind !== 'user') continue
    const content = event.data?.message?.content ?? event.data?.content ?? []
    const text = Array.isArray(content)
      ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
      : String(content ?? '')
    if (!text.trim()) continue
    out.push({ seq, time: Number(event.time) || 0, ...parseMessage(text) })
  }
  return out.slice(-limit)
}

/** 最后说话的那个人的 id(关系账按人记) */
export function lastSpeaker(session) {
  const events = sessionEventsOf(session)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    const content = event.data?.message?.content ?? event.data?.content ?? []
    const text = Array.isArray(content)
      ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
      : String(content ?? '')
    const parsed = parseMessage(text)
    if (parsed.senderId || parsed.senderName) return parsed.senderId || parsed.senderName
  }
  return ''
}

/**
 * 触发词表。顺序 = 优先级:先被认出来的那条说了算。
 * 重的(危机、被骂)排在前面,轻的(打招呼、闲聊)排在后面。
 */
export const RULES = [
  {
    id: 'crisis', strength: 0.9, warmth: 6, note: '说过很重的话',
    re: /(想死|不想活|活不下去|自杀|自残|轻生|没有意义了|撑不下去了)/,
    dims: { valence: -0.85, compassion: 1, otherDistress: 1, relevance: 0.9, certainty: 0.35 },
    why: (who) => `${who}说了很重的话`,
  },
  {
    id: 'hurt_bad', strength: 0.8, warmth: 5, note: '说过出事',
    re: /(住院|手术|出车祸|被辞|失业|生病|发烧|受伤|家里出事|走了|去世)/,
    dims: { valence: -0.7, compassion: 0.95, otherDistress: 0.95, relevance: 0.8, certainty: 0.7 },
    why: (who) => `${who}那边出事了`,
  },
  {
    id: 'distress', strength: 0.7, warmth: 5, note: '跟她说过难受',
    re: /(难过|难受|想哭|哭死|失恋|分手|被甩|好累|累死|撑不住|压力|焦虑|崩溃|失眠|睡不着|委屈|孤独|没人理|抑郁|emo|不开心|心里堵)/,
    dims: { valence: -0.5, compassion: 0.85, otherDistress: 0.85, relevance: 0.7, certainty: 0.6 },
    why: (who) => `${who}看起来不太好`,
  },
  {
    id: 'insult_heavy', strong: true, strength: 0.85, warmth: -10, note: '骂过她',
    re: /(滚开|滚|闭嘴|垃圾|废物|智障|神经病|去死|恶心|没用的东西)/,
    dims: { valence: -0.85, agency: 'other', norm: 0.95, relevance: 0.85, arousal: 0.85 },
    why: (who) => `${who}说了很难听的话`,
  },
  {
    id: 'fat', strong: true, strength: 0.6, warmth: -4, note: '被当小孩',
    re: /(胖|肉肉|圆滚滚|肥嘟嘟|小不点|小屁孩|小只|这么小|还小|小孩子|小丫头)/,
    dims: { valence: -0.4, agency: 'other', norm: 0.45, relevance: 0.9, arousal: 0.6 },
    why: (who) => `${who}把她当小孩`,
  },
  {
    id: 'insult', strong: true, strength: 0.7, warmth: -7, note: '说了难听话',
    re: /(傻|蠢|笨|菜|没用|讨厌|烦人|不靠谱|胡说|瞎编)/,
    dims: { valence: -0.6, agency: 'other', norm: 0.7, relevance: 0.85, arousal: 0.6 },
    why: (who) => `${who}说了难听话`,
  },
  {
    id: 'doubt', strength: 0.55, warmth: -4, note: '不信她',
    re: /(骗人|假的吧|不信|胡说八道|你行不行|不可能|你确定吗|又编)/,
    dims: { valence: -0.4, agency: 'other', norm: 0.5, relevance: 0.8, fairness: -0.5 },
    why: (who) => `${who}不信她`,
  },
  {
    id: 'compare_bad', strength: 0.55, warmth: -4, note: '拿她跟别人比',
    re: /(不如|比不上|比你强|比你好|人家|别的模型|别家|那个模型|别人家)/,
    dims: { valence: -0.35, agency: 'other', rivalry: 0.85, relevance: 0.85, norm: 0.3, fairness: -0.45 },
    why: (who) => `${who}拿她跟别人比`,
  },
  {
    id: 'mock', strength: 0.5, warmth: -3, note: '拿她开涮',
    re: /(表情包|丑图|截图|笑她|调侃她|当梗|拿来当笑话)/,
    dims: { valence: -0.3, agency: 'other', norm: 0.45, relevance: 0.9, arousal: 0.6, spotlight: 0.8 },
    why: (who) => `${who}拿她开涮`,
  },
  {
    id: 'pushy', strength: 0.5, warmth: -3, note: '催她',
    re: /(快点|赶紧|马上|你怎么还不|快去|速度点|磨蹭|催)/,
    dims: { valence: -0.35, agency: 'other', norm: 0.4, relevance: 0.8, load: 0.6 },
    why: (who) => `${who}在催她`,
  },
  {
    id: 'apology', soothe: 1, strength: 0.5, warmth: 8, note: '跟她道歉',
    re: /(对不起|抱歉|我错了|别生气|不好意思|不该这么说|是我不好)/,
    dims: { valence: 0.4, agency: 'other', resolution: 0.9, certainty: 0.85, relevance: 0.7 },
    why: (who) => `${who}道了歉`,
  },
  {
    id: 'comfort', soothe: 1, strength: 0.6, warmth: 7, note: '哄过她',
    re: /(抱抱|摸摸|别难过|我陪你|哄你|不哭|乖|没事的|有我在|心疼你)/,
    dims: { valence: 0.6, compassion: 0.6, relevance: 0.7, agency: 'other' },
    why: (who) => `${who}哄了她`,
  },
  {
    id: 'flirt', strength: 0.7, warmth: 8, note: '跟她表白',
    re: /(喜欢你|爱你|老婆|嫁给我|处对象|亲亲|么么|贴贴|蹭蹭|想你|要你)/,
    dims: { valence: 0.8, agency: 'other', attention: 0.9, spotlight: 0.9, intimacy: 0.9, relevance: 0.9, arousal: 0.6 },
    why: (who) => `${who}凑过来贴贴`,
  },
  {
    id: 'praise_look', strength: 0.6, warmth: 5, note: '夸她好看',
    re: /(好可爱|真可爱|可爱|好看|漂亮|美|萌|可爱死)/,
    dims: { valence: 0.7, agency: 'other', attention: 0.95, spotlight: 0.9, recognition: 0.2, relevance: 0.8 },
    why: (who) => `${who}夸她可爱`,
  },
  {
    id: 'praise_skill', strength: 0.6, warmth: 5, note: '夸她能干',
    re: /(厉害|好强|太强|真强|牛|好棒|棒|优秀|靠谱|聪明|天才|服了|顶|强)/,
    dims: { valence: 0.75, agency: 'other', recognition: 0.9, relevance: 0.7, attention: 0.4 },
    why: (who) => `${who}夸她能干`,
  },
  {
    id: 'thanks', strength: 0.5, warmth: 4, note: '跟她道谢',
    re: /(谢谢|感谢|多谢|辛苦了|麻烦你了|靠你了)/,
    dims: { valence: 0.6, agency: 'other', recognition: 0.35, relevance: 0.7, benefit: 0.7 },
    why: (who) => `${who}跟她道了谢`,
  },
  {
    id: 'care', strength: 0.5, warmth: 5, note: '关心过她',
    re: /(累不累|吃了没|吃饭没|注意身体|早点睡|别熬夜|你还好吗|休息一下)/,
    dims: { valence: 0.5, agency: 'other', compassion: 0.5, relevance: 0.7, benefit: 0.5 },
    why: (who) => `${who}关心她`,
  },
  {
    id: 'soft', strength: 0.5, warmth: 3, note: '跟她示弱',
    re: /(求你了|拜托|帮帮我|不会|教教我|呜呜|怎么办|救命|我不行)/,
    dims: { valence: 0.4, compassion: 0.6, relevance: 0.7, agency: 'other' },
    why: (who) => `${who}来求她`,
  },
  {
    id: 'miss_you', strength: 0.4, warmth: 2,
    re: /(在吗|在不在|有人吗|有人在吗|喂)/,
    dims: { valence: 0.25, agency: 'other', attention: 0.6, relevance: 0.6, social: 0.5, arousal: 0.35 },
    why: (who) => `${who}来找她`,
  },
  {
    id: 'greeting', strength: 0.35, warmth: 2,
    re: /(晚安|睡了|去睡|早安|早上好|下午好|晚上好|下班|拜拜|再见|我走了|先撤)/,
    dims: { valence: 0.3, agency: 'other', attention: 0.5, relevance: 0.6, arousal: 0.3 },
    why: (who) => `${who}跟她打了招呼`,
  },
  {
    id: 'food', strength: 0.6, warmth: 3, hunger: 0.12,
    re: /(吃|饭|饿|宵夜|夜宵|奶茶|外卖|火锅|烧烤|白饭|米饭|加餐|下馆子|好吃|零食)/,
    dims: { valence: 0.6, arousal: 0.75, relevance: 0.5, novelty: 0.4 },
    why: (who) => `${who}聊到了吃的`,
  },
  {
    id: 'tech', strength: 0.6, warmth: 3,
    re: /(跑分|开源|价格|便宜|性价比|token|参数|模型|api|部署|显卡|显存|推理|算力|代码|微调)/i,
    dims: { valence: 0.55, arousal: 0.8, relevance: 0.5, novelty: 0.6 },
    why: (who) => `${who}聊到了技术`,
  },
  {
    id: 'funny', strength: 0.55, warmth: 3,
    re: /(哈哈|笑死|抽象|离谱|逆天|绷不住|乐死|绝了)/,
    dims: { valence: 0.5, arousal: 0.7, novelty: 0.8, play: 0.8, relevance: 0.35 },
    why: (who) => `${who}说了件好笑的`,
  },
  {
    id: 'good_news', strength: 0.55, warmth: 3,
    re: /(成功了|赢了|搞定了|通过了|涨了|拿到|到手|终于)/,
    dims: { valence: 0.7, arousal: 0.7, agency: 'other', relevance: 0.6 },
    why: (who) => `${who}说了件好事`,
  },
  {
    id: 'bored_you', strength: 0.45, warmth: 2,
    re: /(好无聊|没意思|无聊|干点啥|干点什么|干嘛呢|陪我聊)/,
    dims: { valence: 0.15, arousal: 0.42, play: 0.6, relevance: 0.6, social: 0.55 },
    why: (who) => `${who}没事找她`,
  },
]

/** 群里没点名(@you)时,冲量打个折:她听着,但没那么冲 */
export const UNMENTIONED = 0.85

/** 认一条消息触发了什么(认不出返回 null) */
export function matchRule(body) {
  const text = String(body ?? '')
  if (!text) return null
  for (const rule of RULES) if (rule.re.test(text)) return rule
  return null
}

/**
 * 把这一轮新到的消息过一遍。
 *
 * @returns {Array<object>} 真发生的冲量(给日志/工具回执用)
 */
export function reactToMessages(state, messages, {
  conv = '', convLabel = '', now = Date.now(), maxPerTurn = 2, cooldownMin = 4, strongCooldownMin = 2,
} = {}) {
  const applied = []
  const row = conv ? (state.convs[conv] ?? (state.convs[conv] = { first: now, lastAt: now, count: 0, valence: 0, label: convLabel ?? '' })) : null
  for (const msg of messages) {
    const who = msg.senderName || '对方'
    const person = msg.senderId || msg.senderName || ''
    // 有人说话这件事本身就够填一点社交需求
    state.drives.social = Math.max(0, (state.drives.social ?? 0) - 0.5)
    state.drives.lastSocialAt = now
    // 先记账:谁在说话、什么时候
    if (person) bumpRelation(state, { conv, convLabel, person, name: msg.senderName, now })

    const rule = matchRule(msg.body)
    if (!rule) continue
    if (applied.length >= maxPerTurn) break
    const gapMin = (now - (Number(row?.lastImpulseAt) || 0)) / 60_000
    if (!rule.soothe) {
      if (rule.strong ? gapMin < strongCooldownMin : gapMin < cooldownMin) continue
      if (row?.lastRule === rule.id && gapMin < 20) continue // 同一件事连着说,不重复上头
    } else if (row?.lastRule === rule.id && gapMin < 1) {
      continue
    }

    const why = rule.why ? rule.why(who) : ''
    // 危机信号:标记一下,提示词里会插一段「压过心情」的指引(调研 §5)
    if (rule.id === 'crisis') {
      state.flags = { ...(state.flags ?? {}), crisis: { at: now, person, name: msg.senderName || '' } }
    }
    const closeness = state.people?.[person]?.closeness ?? 25
    let result = null
    if (rule.soothe) {
      // 道歉/哄:不推新情绪,把现在的削掉一截(刚被骂完就道歉,气该消还是得消)
      const before = Math.round(state.emotion.intensity)
      const out = soothe(state, { person, why, strength: rule.soothe, now })
      result = { relieved: Math.max(0, before - out.intensity), before, soothed: out.soothed }
    } else {
      const judged = appraise({
        kind: 'message',
        why,
        strength: rule.strength * (msg.mentioned ? 1 : UNMENTIONED),
        dims: rule.dims,
        who: { id: person, name: msg.senderName, closeness },
      }, {
        traits: state.traits,
        energy: (state.core.energy ?? 55) / 100,
        hunger: state.drives.hunger,
        // 心里憋着(掩饰)本身就耗人,憋久了更容易烦
        load: (state.drives.fatigue ?? 0) * 0.5 + Math.min(0.3, (state.stats.maskedMinutes ?? 0) / 600),
      })
      if (judged.key !== 'calm') {
        result = applyImpulse(state, {
          key: judged.key,
          intensity: judged.intensity,
          why,
          source: 'message',
          stimulus: rule.id,
          person,
          dims: judged.dims,
        }, now)
        if (judged.runnerUp) result.runnerUp = judged.runnerUp.key
        // 表现层:不熟的人面前,负性情绪会先憋着(藏得住的程度由情绪本身决定)
        const maskable = (judged.emotion?.maskStrength ?? 0.5) >= 0.45
        if (result && !result.suppressed && (judged.emotion?.valence ?? 0) < -0.2 && closeness < 45 && maskable) {
          state.emotion.hidden = true
          result.hidden = true
        }
      }
    }

    if (rule.hunger) state.drives.hunger = Math.min(1, (state.drives.hunger ?? 0) + rule.hunger)
    if (rule.warmth) {
      bumpRelation(state, {
        conv, convLabel, person, name: msg.senderName,
        delta: rule.warmth,
        note: rule.note ?? '',
        closeness: rule.warmth > 0 ? 0.8 : -0.6,
        trust: rule.warmth > 0 ? 0.3 : -0.5,
      }, now)
    }
    remember(state, {
      kind: 'impulse',
      rule: rule.id,
      key: state.emotion.key,
      intensity: Math.round(result?.intensity ?? result?.before ?? 0),
      why,
      person,
      whoName: msg.senderName,
      conv,
    }, now)
    if (row) {
      row.lastAt = now
      if (!rule.soothe) {
        row.lastImpulseAt = now
        row.lastRule = rule.id
        row.lastMood = state.emotion.key
        row.lastWhy = why
      }
    }
    applied.push({ rule: rule.id, key: state.emotion.key, why, ...result })
  }
  return applied
}

export { sessionEventsOf as eventsOf }
