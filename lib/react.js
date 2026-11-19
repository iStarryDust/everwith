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
import { applyImpulse, bumpRelation, endScene, intimacyLevelOf, remember, soothe, touchScene } from './state.js'

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
    id: 'distress', strength: 0.7, warmth: 5, note: '有人说了难受的事',
    re: /(难过|难受|想哭|哭死|失恋|分手|被甩|好累|累死|撑不住|压力|焦虑|崩溃|失眠|睡不着|委屈|孤独|没人理|抑郁|emo|不开心|心里堵)/,
    dims: { valence: -0.5, compassion: 0.85, otherDistress: 0.85, relevance: 0.7, certainty: 0.6 },
    why: (who) => `${who}看起来不太好`,
  },
  {
    id: 'insult_heavy', strong: true, strength: 0.85, warmth: -10, note: '被骂',
    re: /(滚开|滚|闭嘴|垃圾|废物|智障|神经病|去死|恶心|没用的东西)/,
    dims: { valence: -0.85, agency: 'other', norm: 0.95, relevance: 0.85, arousal: 0.85 },
    why: (who) => `${who}说了很难听的话`,
  },
  {
    id: 'small', strong: true, strength: 0.55, warmth: -3, note: '被当小孩',
    re: /(小不点|小屁孩|小只|这么小|还小|小孩子|小丫头|小朋友|像小孩|长不大)/,
    dims: { valence: -0.4, agency: 'other', norm: 0.4, relevance: 0.9, arousal: 0.55 },
    why: (who) => `${who}把我当小孩说`,
  },
  {
    id: 'body', strong: true, strength: 0.6, warmth: -4, note: '被说身材',
    re: /(肉肉|圆滚滚|胖嘟嘟|肥嘟嘟|腿粗|平胸|没身材|小胖)/,
    dims: { valence: -0.6, agency: 'other', norm: 0.55, relevance: 0.9, arousal: 0.6, spotlight: 0.7 },
    why: (who) => `${who}拿身材说事`,
  },
  {
    id: 'insult', strong: true, strength: 0.7, warmth: -7, note: '说了难听话',
    re: /(傻|蠢|笨|菜|没用|讨厌|烦人|不靠谱|胡说|瞎编)/,
    dims: { valence: -0.6, agency: 'other', norm: 0.7, relevance: 0.85, arousal: 0.6 },
    why: (who) => `${who}说了刺人的话`,
  },
  {
    id: 'doubt', strength: 0.55, warmth: -4, note: '被怀疑',
    re: /(骗人|假的吧|不信|胡说八道|你行不行|不可能|你确定吗|又编)/,
    dims: { valence: -0.4, agency: 'other', norm: 0.5, relevance: 0.8, fairness: -0.5 },
    why: (who) => `${who}不信我`,
  },
  {
    id: 'compare_bad', strength: 0.55, warmth: -4, note: '被拿来比较',
    re: /(不如|比不上|比你强|比你好|人家|别的模型|别家|那个模型|别人家)/,
    dims: { valence: -0.35, agency: 'other', rivalry: 0.85, relevance: 0.85, norm: 0.3, fairness: -0.45 },
    why: (who) => `${who}拿我跟别人比`,
  },
  {
    id: 'other_girl', strength: 0.6, warmth: -5, note: '提到别的女生',
    re: /(别的女生|另一个女生|别的女孩|前女友|比我好看|她比我|她好看|她可爱|她漂亮|人家女朋友)/,
    dims: { valence: -0.5, agency: 'other', rivalry: 0.9, relevance: 0.8, intimacy: 0.5, arousal: 0.7 },
    why: (who) => `${who}提到别的女生`,
  },
  {
    id: 'mock', strength: 0.5, warmth: -3, note: '被开涮',
    re: /(丑图|截图|笑她|调侃她|当梗|拿来当笑话|嘲笑)/,
    dims: { valence: -0.3, agency: 'other', norm: 0.45, relevance: 0.9, arousal: 0.6, spotlight: 0.8 },
    why: (who) => `${who}拿我开玩笑`,
  },
  {
    id: 'pushy', strength: 0.5, warmth: -3, note: '被催',
    re: /(快点|赶紧|马上|你怎么还不|快去|速度点|磨蹭|催)/,
    dims: { valence: -0.35, agency: 'other', norm: 0.4, relevance: 0.8, load: 0.6 },
    why: (who) => `${who}在催我`,
  },
  {
    id: 'apology', soothe: 1, strength: 0.5, warmth: 8, note: '收到道歉',
    re: /(对不起|抱歉|我错了|别生气|不好意思|不该这么说|是我不好)/,
    dims: { valence: 0.4, agency: 'other', resolution: 0.9, certainty: 0.85, relevance: 0.7 },
    why: (who) => `${who}向我道歉`,
  },
  {
    id: 'comfort', soothe: 1, strength: 0.6, warmth: 7, note: '被哄',
    re: /(抱抱|摸摸|别难过|我陪你|哄你|不哭|乖|没事的|有我在|心疼你)/,
    dims: { valence: 0.6, compassion: 0.6, relevance: 0.7, agency: 'other' },
    why: (who) => `${who}哄我`,
  },
  {
    id: 'flirt', strength: 0.7, warmth: 8, note: '收到表白',
    re: /(喜欢你|爱你|老婆|嫁给我|处对象|亲亲|么么|贴贴|蹭蹭|想你|要你)/,
    dims: { valence: 0.8, agency: 'other', attention: 0.9, spotlight: 0.9, intimacy: 0.9, relevance: 0.9, arousal: 0.6 },
    why: (who) => `${who}凑过来贴贴`,
  },
  {
    id: 'hair', strength: 0.55, warmth: 4, note: '被说头发或裙子',
    re: /(马尾|头发|白丝|过膝袜|百褶裙|裙子|穿这么少)/,
    dims: { valence: 0.5, agency: 'other', attention: 0.9, spotlight: 0.85, intimacy: 0.5, relevance: 0.8, arousal: 0.55 },
    why: (who) => `${who}盯着我看`,
  },
  {
    id: 'touch', strength: 0.6, warmth: 6, note: '被碰到',
    re: /(摸头|揉头|捏脸|碰耳朵|耳朵|腰侧|脚踝|怕痒|好痒)/,
    dims: { valence: 0.5, agency: 'other', attention: 0.95, spotlight: 0.85, intimacy: 0.85, relevance: 0.85, arousal: 0.75 },
    why: (who) => `${who}碰到我`,
  },
  {
    id: 'praise_look', strength: 0.6, warmth: 5, note: '被夸好看',
    re: /(好可爱|真可爱|可爱|好看|漂亮|萌|可爱死)/,
    dims: { valence: 0.7, agency: 'other', attention: 0.95, spotlight: 0.9, recognition: 0.2, relevance: 0.8 },
    why: (who) => `${who}夸我可爱`,
  },
  {
    id: 'praise_skill', strength: 0.6, warmth: 5, note: '被夸能干',
    re: /(厉害|好强|太强|真强|牛|好棒|棒|优秀|靠谱|聪明|天才|服了|顶|强)/,
    dims: { valence: 0.75, agency: 'other', recognition: 0.9, relevance: 0.7, attention: 0.4 },
    why: (who) => `${who}夸我能干`,
  },
  {
    id: 'code', strength: 0.55, warmth: 4, note: '看作品',
    re: /(改好了|修好了|跑通了|编译过|写得不错|这段代码|debug|调试|提交上去了)/i,
    dims: { valence: 0.65, agency: 'other', recognition: 0.85, relevance: 0.7, attention: 0.4 },
    why: (who) => `${who}看了我的作品`,
  },
  // ── 技术日常:强度都不高(不改心情),但都值得记住 ──────────────────────
  // memoryFloor 是「记进记忆的最小强度」——这几条情绪上很淡,但聊过什么得留下来。
  {
    id: 'coding', strength: 0.3, note: '在写代码',
    re: /(写代码|改代码|写个函数|重构|加个功能|写插件|敲代码|在编码|写组件)/i,
    dims: { valence: 0.25, agency: 'other', relevance: 0.65, attention: 0.55 },
    why: (who) => `${who}在写代码`,
    memoryFloor: 20,
  },
  {
    id: 'bug', strength: 0.28, note: '卡在报错上',
    re: /(报错|崩了|跑不起来|编译不过|SyntaxError|undefined|卡住了|调不通|不生效|又炸了|构建失败)/i,
    dims: { valence: -0.25, agency: 'other', relevance: 0.7, attention: 0.6, load: 0.45 },
    why: (who) => `${who}卡在报错上`,
    memoryFloor: 20,
  },
  {
    id: 'plan', strength: 0.3, note: '在商量方案',
    re: /(方案|架构|怎么设计|思路|要不要改成|对比一下|选哪个|权衡|取舍|先做哪)/i,
    dims: { valence: 0.3, agency: 'other', relevance: 0.7, attention: 0.6 },
    why: (who) => `${who}在商量方案`,
    memoryFloor: 20,
  },
  {
    id: 'thanks', strength: 0.5, warmth: 4, note: '收到道谢',
    re: /(谢谢|感谢|多谢|辛苦了|麻烦你了|靠你了)/,
    dims: { valence: 0.6, agency: 'other', recognition: 0.35, relevance: 0.7, benefit: 0.7 },
    why: (who) => `${who}向我道谢`,
  },
  {
    id: 'care', strength: 0.5, warmth: 5, note: '被关心',
    re: /(累不累|吃了没|吃饭没|注意身体|早点睡|别熬夜|你还好吗|休息一下)/,
    dims: { valence: 0.5, agency: 'other', compassion: 0.5, relevance: 0.7, benefit: 0.5 },
    why: (who) => `${who}关心我`,
  },
  {
    id: 'soft', strength: 0.5, warmth: 3, note: '被示弱',
    re: /(求你了|拜托|帮帮我|不会|教教我|呜呜|怎么办|救命|我不行)/,
    dims: { valence: 0.4, compassion: 0.6, relevance: 0.7, agency: 'other' },
    why: (who) => `${who}来求我`,
  },
  {
    id: 'miss_you', strength: 0.4, warmth: 2,
    re: /(在吗|在不在|有人吗|有人在吗|喂)/,
    dims: { valence: 0.25, agency: 'other', attention: 0.6, relevance: 0.6, social: 0.5, arousal: 0.35 },
    why: (who) => `${who}来找我`,
  },
  {
    id: 'greeting', strength: 0.35, warmth: 2,
    re: /(晚安|睡了|去睡|早安|早上好|下午好|晚上好|下班|拜拜|再见|我走了|先撤)/,
    dims: { valence: 0.3, agency: 'other', attention: 0.5, relevance: 0.6, arousal: 0.3 },
    why: (who) => `${who}跟我打了招呼`,
  },
  {
    id: 'food', strength: 0.6, warmth: 3, hunger: 0.12,
    re: /(吃|饭|饿|宵夜|夜宵|奶茶|外卖|火锅|烧烤|甜|蛋糕|草莓|零食|好吃|馋)/,
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
    re: /(哈哈|笑死|离谱|逆天|绷不住|乐死|绝了)/,
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
    why: (who) => `${who}没事来找我`,
  },
]

/**
 * 亲密规则组:只在 intimacy.level 够的时候参与匹配,优先级压在普通规则之前。
 *
 * 它们**不写任何台词**,只做两件事:
 *   1. 把场景往前推(日常 → 前戏 → 进行 → 事后);
 *   2. 给身体和欲望加冲量,让情绪和回复参数自己变。
 * 台词永远是模型的事 —— 插件里存句子就会变成模板。
 */
export const INTIM_RULES = [
  {
    id: 'intim_touch', minLevel: 1, phase: 'foreplay', intimacy: 0.16, heat: 0.12,
    re: /(摸|揉|亲|抱|蹭|贴|舔|咬|捏|搂)/,
    dims: { valence: 0.55, agency: 'other', attention: 0.8, spotlight: 0.6, intimacy: 0.75, relevance: 0.85, arousal: 0.6, desire: 0.5 },
    why: (who) => `${who}碰过来`,
  },
  {
    id: 'intim_sensitive', minLevel: 1, phase: 'foreplay', intimacy: 0.32, heat: 0.2,
    re: /(耳朵|耳垂|脖子|腰侧|脚踝|小穴|乳尖|白丝|裙子底下)/,
    dims: { valence: 0.45, agency: 'other', attention: 0.9, spotlight: 0.8, intimacy: 0.85, relevance: 0.9, arousal: 0.8, desire: 0.7 },
    why: (who) => `${who}碰到我敏感的地方`,
  },
  {
    id: 'intim_undress', minLevel: 1, phase: 'foreplay', intimacy: 0.3, heat: 0.22,
    re: /(脱|掀|褪|拉下去|解开|光着|不穿)/,
    dims: { valence: 0.4, agency: 'other', attention: 0.9, spotlight: 0.85, intimacy: 0.8, relevance: 0.85, arousal: 0.75, desire: 0.75 },
    why: (who) => `${who}动手脱衣`,
  },
  {
    id: 'intim_climax', minLevel: 2, phase: 'end', intimacy: 0.2, heat: 0.4,
    re: /(到了|要去|射|高潮|受不住|不行了)/,
    dims: { valence: 0.7, agency: 'other', intimacy: 0.95, relevance: 0.95, arousal: 1, resolution: 0.85, desire: 1 },
    why: (who) => `和${who}一起到了`,
  },
  {
    id: 'intim_enter', minLevel: 2, phase: 'active', intimacy: 0.3, heat: 0.28,
    re: /(进去|插|顶进来|坐上去|吞到)/,
    dims: { valence: 0.5, agency: 'other', intimacy: 0.95, relevance: 0.95, arousal: 0.95, desire: 0.9 },
    why: (who) => `${who}进来了`,
  },
  {
    id: 'intim_deep', minLevel: 2, phase: 'active', intimacy: 0.25, heat: 0.32,
    re: /(到底|最深|太深|里面|深一点|别停|再来一次)/,
    dims: { valence: 0.35, agency: 'other', intimacy: 0.95, relevance: 0.95, arousal: 1, desire: 1 },
    why: (who) => `${who}顶到最里面`,
  },
  {
    id: 'intim_after', minLevel: 1, phase: 'after', intimacy: 0.2, heat: 0,
    re: /(喘|靠着|窝在|抱着|睡一会儿|累不累)/,
    dims: { valence: 0.75, agency: 'other', intimacy: 0.9, relevance: 0.8, compassion: 0.35, resolution: 0.6, arousal: 0.15 },
    why: (who) => `${who}抱过来`,
  },
]

/** 认一条亲密规则;等级不够就当没认出来 */
export function matchIntimRule(body, level = 1) {
  const text = String(body ?? '')
  if (!text) return null
  for (const rule of INTIM_RULES) {
    if (level < (rule.minLevel ?? 1)) continue
    if (rule.re.test(text)) return rule
  }
  return null
}

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

    const rule = matchIntimRule(msg.body, intimacyLevelOf(state)) ?? matchRule(msg.body)
    if (!rule) continue
    if (applied.length >= maxPerTurn) break
    const isIntim = typeof rule.phase === 'string'
    const gapMin = (now - (Number(row?.lastImpulseAt) || 0)) / 60_000
    if (!isIntim) {
      if (!rule.soothe) {
        if (rule.strong ? gapMin < strongCooldownMin : gapMin < cooldownMin) continue
        if (row?.lastRule === rule.id && gapMin < 20) continue // 同一件事连着说,不重复上头
      } else if (row?.lastRule === rule.id && gapMin < 1) {
        continue
      }
    }

    // 亲密规则先把场景往前推,再走同一套评价
    if (isIntim) {
      if (rule.phase === 'after') touchScene(state, { phase: 'afterglow', intimacy: rule.intimacy, heat: 0, now })
      else if (rule.phase === 'end') endScene(state, now)
      else touchScene(state, { phase: rule.phase, intimacy: rule.intimacy, heat: rule.heat ?? 0.15, now })
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
        desire: state.drives.desire ?? 0,
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
          // 情绪不浓、但事件值得留的规则(写代码/报错/商量方案)靠这个压低记忆门槛
          memoryFloor: rule.memoryFloor,
        }, now)
        if (result && judged.runnerUp) result.runnerUp = judged.runnerUp.key
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
      // 有些规则情绪很淡、但事件值得留(memoryFloor),取两者大的那个
      intensity: Math.max(Math.round(result?.intensity ?? result?.before ?? 0), Number(rule.memoryFloor) || 0),
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
