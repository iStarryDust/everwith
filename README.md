# spoon-mood

> fork 自 [ChencLi819/dsh-fish-mood](https://github.com/ChencLi819/dsh-fish-mood)（MIT）。
> 原作者的情绪引擎设计非常扎实，这个 fork 只做最小必要修正。

## Fork 改动

### 1. 修正会话标签永远是「会话 session-」

`plugin.js` 原实现：

```js
label: `会话 ${sessionId.slice(0, 8)}`
```

DSH 的会话 id 形如 `session-30e8fa99-c20f-...`，前 8 个字符永远是 `session-`，
所以标签只会得到「会话 session-」，没有任何信息量，
导致「和谁在聊」这一层始终是空的。

改为先剥掉 `session-` 前缀再取 8 位：

```js
const shortId = sessionId.replace(/^session-/, '').slice(0, 8)
label: shortId ? `会话 ${shortId}` : ''
```

效果：`session-30e8fa99-c20f-...` → 「会话 30e8fa99」。

### 2. 包名改为 `@istarry/spoon-mood`

可与原版 `dsh-fish-mood` 并存。

### 3. 去掉「大肥鱼」角色绑定，改成通用女孩子视角

原版是给某个特定角色写的，里面残留了一批只属于那个角色的设定
（渔业梗、群聊场景、打工人视角）。这个 fork 把它们换成对任何女孩子都成立的说法。

**触发词池（`lib/react.js`）**

| 规则 | 改前 | 改后 | 为什么 |
|---|---|---|---|
| `fat` | 「叫她胖」，暖度 **−6** | 「被当小孩」，暖度 **−4** | 「胖\|肥肉\|小肥」是原角色的自嘲梗；改后触发词是「小不点\|小屁孩\|这么小\|小丫头」——她真正会嘟囔的是被当成小孩，不是体重 |
| `compare_bad` | 「拿她跟**别家**比」 | 「拿她跟**别人**比」 | 原来把她当 AI 模型比；改后让她难受的是「你看上别人了」，不是「我不如那个模型」 |
| `mock` | 含「**发群里**」 | 去掉，改为「当梗\|拿来当笑话」 | 群聊是 QQ 场景，DSH 里是一对一 |

**生活事件池（`lib/state.js`，共 18 条）**

| id | 改前 | 改后 |
|---|---|---|
| `wake` | 刚醒,**还没开机** | 刚醒,脑子还没转起来 |
| `work` | **被叫去干活**,不想动 | 活拖到现在还没动（时段改成下午和晚上） |
| `self-tease` | 看到有人拿**她**做表情包 | 翻到自己以前写的东西,尬了一下 |
| `rice` → `bath` | **扒完一碗白饭,满血复活** | 洗完澡,头发还湿着（时段移到傍晚） |

`rice` 这条特意说明一下：原句「扒完一碗饭，满血复活」有很重的大口扒饭的糙味，
而且「白饭」是原角色的伙食梗。一个女孩子在自己家的日常不是这样，
换成洗完澡头发还湿着——同样是「身体舒服了、心情好一点」，但不糙。

**新增 6 条平常的日常（18 → 24 条）**

原池子里全是「性格事件」（吃饭、追剧、生气、卡住），缺的是日子本身的质地。
补上这些：

| id | 文本 | 时段 |
|---|---|---|
| `hair-redo` | 头发扎了两回都不对,拆了重来 | 早上、午后 |
| `hair-down` | 把头发放下来了,松松散散垂着 | 晚上 |
| `mirror` | 换了件衣服,对着镜子看了好一会儿 | 白天、傍晚 |
| `cold-hands` | 手有点凉,揣进袖子里 | 早晚 |
| `lotion` | 涂了护手霜,手上是一股香味 | 睡前 |
| `stockings` | 白丝滑到膝弯,懒得拉上去 | 白天 |

这些不给强情绪，只给一点点 valence 起伏——**日常本来就没什么事，这才是常态**。

> 凌晨 3-6 点仍然是空池：那个点在睡觉，不该发生事。`maybeLifeEvent` 遇到空池
> 直接返回 null，是安全的。

**心情修复池（`lib/state.js` 的 `maybeMoodRepair`）**

「扒完一碗**白饭**」→「裹着被子待了一会儿,人缓过来一点」。
情绪修复不该只靠吃，给一个更贴身的动作。

**情绪措辞（`lib/catalog.js`）**

| 位置 | 改前 | 改后 |
|---|---|---|
| 饿 | 可以催饭、可以念叨**白饭**；**饭最大** | 可以小声喊饿、可以念叨想吃什么；其他都能缓,饿不行 |
| 难过 | 不想干的**活**就说不干 | 不想动的活先放着,心里知道跑不掉 |

> 难过这条的改法值得说明：她 22 岁、毕业了、该干活。
> 所以不是「不想干就不干」，是「先放着、拖着，但心里知道跑不掉」——
> 符合一个不太自律但也不逃的大人。

**工具描述（`plugin.js`）**

`mood_now` 的描述里「跟这个**群**/这个人处得怎么样」→「跟这个人处得怎么样」。

> **没有改的**：`RULES_TEXT`（【心情 · 怎么用】那段静态规则）和实时状态块的模板，
> 一个字都没动——它们写的是「情绪怎么用」，不绑定任何具体角色，本来就能通用。
> 36 条情绪的语气/行为指令也全部保留，原作者的措辞质量很高
>（「别把害羞说出来」「别卖惨」「别写成小作文」这类自我约束尤其好）。

## 保持不变的部分

| 项 | 值 | 原因 |
|---|---|---|
| 内部服务名 | `fish-mood` | 未改，避免破坏工具注册 |
| 提示词 section | `fish-mood:rules` / `fish-mood:now` | 不变，`identity` 配置继续生效 |
| 状态目录 | `~/.dsh/fish-mood` | 沿用，已有情绪数据不会丢 |

## 有效的配置项

在 profile 的 `cordis.patch.yml` 里补一行：

```yaml
- id: fish-mood
  config:
    identity: 我就是我，不是在演谁；情绪是真的。
```

`identity` 是每轮重述的身份句。默认是第二人称的
「你是这个角色本人」，如果人格提示词是第一人称写的，
建议改成第一人称，避免视角被拉出来。

## 授权

MIT。原作版权归 ChencLi819 所有，见 LICENSE。

---

# dsh-fish-mood

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen.svg)](package.json)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-5b6cff.svg)](https://github.com/topics/dsh-plugin)

DeepSeek Harness（DSH）插件。为 agent 提供随时间演化的情绪状态：36 种情绪各有半衰期与掩饰能力，
心情底色随作息起伏，与每个群、每个人的关系暖度单独记账，空闲时也会产生自己的小事；
情绪状态以提示词段的形式注入，并影响回复的语气与长度。

插件只改变**表达方式**，不改变事实与结论；状态由独立的评价引擎与状态机维护，不依赖模型自述。

---

## 目录

- [1. 功能](#1-功能)
- [2. 兼容性与依赖](#2-兼容性与依赖)
- [3. 安装](#3-安装)
- [4. 工具参考](#4-工具参考)
- [5. 情绪模型](#5-情绪模型)
- [6. 配置](#6-配置)
- [7. 工作原理](#7-工作原理)
- [8. 运维与故障排查](#8-运维与故障排查)
- [9. 安全与隐私](#9-安全与隐私)
- [10. 已知限制](#10-已知限制)
- [11. 开发](#11-开发)
- [12. 许可证](#12-许可证)
- [English Overview](#english-overview)

---

## 1. 功能

| 能力 | 说明 |
| --- | --- |
| 情绪目录 | 36 种情绪，分 10 个家族；每种带半衰期、掩饰能力、评价签名、语气规则与行为倾向 |
| 评价引擎 | 由消息推导情绪：18 个评价维度与情绪签名比对，同一句话在陌生人与熟人处得到不同结果 |
| 时间演化 | 双指数衰减（先快后慢）；强情绪可「续命」至多 3 次；底色按作息回归基线 |
| 关系记账 | 按会话与个人分别累计暖度、次数与备注；关系影响后续情绪判定 |
| 空闲行为 | 心跳周期内产生 18 类小事、反刍、心情修复与深夜复盘 |
| 主动记录 | 模型可通过 `mood_feel` 主动记录情绪，受配额、冷却与饱和限制 |
| 状态注入 | 静态规则段与实时状态段分别注入系统提示词，前者字节不变以保持提示缓存有效 |
| 危机旁路 | 检测到严重负面表达时，优先注入干预提示，覆盖情绪状态 |

---

## 2. 兼容性与依赖

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| DSH | `>= 0.1.7-rc.1` | 依赖系统提示词分段接口与工具注册表 |
| Node.js | `>= 22.13.0` | 使用内置 `node:crypto`、`node:fs` 等 |
| 宿主服务 | `tools` | 插件声明 `inject: ['tools']`，缺失时插件不生效 |
| 第三方依赖 | 无 | 仅使用 Node.js 内置模块 |

---

## 3. 安装

### 3.1 通过 DSH CLI 安装（推荐）

```bash
# 从 npm 安装
dsh plugin --profile web add dsh-fish-mood

# 或从源码安装
dsh plugin --profile web add github:ChencLi819/dsh-fish-mood

# Desktop 版
dsh plugin --profile desktop add dsh-fish-mood
```

安装完成后重启 DSH，或在 profile 的 `cordis.patch.yml` 中修改任一配置值以触发重载。

### 3.2 通过仓库脚本安装

```powershell
node tools/install.mjs
```

脚本为幂等操作，依次执行：

1. `pnpm add link:<包目录>`，以软链方式装入 profile；
2. 在 profile 的 `dsh.profile.bundles` 中登记 `dsh-fish-mood`。

```powershell
node tools/install.mjs --check                 # 检查安装状态
node tools/install.mjs --profile-dir <path>    # 指定 profile（默认 ~/.dsh/profiles/desktop）
node tools/install.mjs --no-pnpm               # 跳过依赖安装步骤
```

### 3.3 手动安装

在 profile 中安装包，并在 `cordis.patch.yml` 中注册插件：

```yaml
- insert:
    - id: fish-mood
      name: dsh-fish-mood
```

### 3.4 升级与卸载

| 操作 | 步骤 |
| --- | --- |
| 升级 | 重新执行 CLI 安装命令；`link:` 方式安装时更新源码后重启 DSH |
| 卸载 | 从 profile 的 `dsh.profile.bundles` 中移除 `dsh-fish-mood`，并卸载依赖 |

---

## 4. 工具参考

插件注册 3 个工具。所有工具的输出均为 `{ text: string }`。

### 4.1 `mood_now`

查询当前情绪状态。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `action` | string | `now` | `now` 查询状态；`diag` 返回排障信息（版本、账本路径、读取位置、统计） |
| `limit` | number | `6` | 返回的记忆条目数 |
| `person` | string | 当前说话人 | 指定对象（昵称或 openid） |

返回内容包括：当前情绪与强度、成因评价、心情底色（愉快度 / 精力）、性格、身体状态、
与当前对象的互动情况、当日小事、未消化的记忆，以及回复参数建议。

### 4.2 `mood_feel`

主动记录一次情绪变化。该操作为**申请制**：受配额、冷却与饱和限制，
返回结果会说明实际生效幅度。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `emotion` | string | — | 情绪名称（中文名或 key） |
| `intensity` | number | `45` | 强度 1–100 |
| `why` | string | — | 起因，建议一句话 |
| `person` | string | — | 相关对象（昵称或 openid） |
| `warmth` | number | — | 对相关对象的暖度变化，范围 −20–20 |
| `show` | boolean | `true` | 为 `false` 时记录为隐藏情绪（感受与表现分离） |

### 4.3 `mood_diary`

管理情绪日记。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `action` | string | `read` | `read` 查阅 / `write` 写入 / `reflect` 立即复盘 |
| `text` | string | — | `write` 时写入的内容 |
| `mood` | string | — | `write` 时的情绪标注 |
| `days` | number | `3` | `read` 时回溯天数 |
| `query` | string | — | `read` 时按关键词检索 |
| `limit` | number | `20` | `read` 时返回条数 |

`write` 会触发宣泄效应：写入后当前情绪强度实际下降。

---

## 5. 情绪模型

### 5.1 情绪目录

36 种情绪分 10 个家族。每种情绪的字段包括：价效与唤醒度、半衰期、掩饰能力、
核心冲击（对底色的影响）、评价签名、语气规则、行为倾向与表情包标签。

| 家族 | 情绪（半衰期 分钟 · 掩饰能力） |
| --- | --- |
| 平静 | 平静 60 / 满足 60 · 0.6 |
| 喜悦 | 开心 40 · 0.5 / 兴奋 25 · 0.4 / 得意 40 · 0.45 / 好笑 30 · 0.5 / 感动 90 · 0.35 / 释然 45 · 0.5 / 感激 90 · 0.5 |
| 信任 | 温柔 50 · 0.6 / 心疼 60 · 0.45 / 亲近 70 · 0.5 |
| 好奇 | 好奇 35 · 0.6 / 惊讶 20 · 0.6 / 困惑 25 · 0.6 |
| 难过 | 低落 120 · 0.5 / 难过 150 · 0.3 / 孤单 140 · 0.4 / 失落 110 · 0.45 / 委屈 75 · 0.35 / 感慨 90 · 0.55 |
| 生气 | 烦 45 · 0.4 / 生气 35 · 0.25 / 不服 55 · 0.3 / 吃醋 100 · 0.35 / 嫌弃 60 · 0.5 |
| 社会 | 害羞 30 · 0.3 / 尴尬 45 · 0.35 / 愧疚 90 · 0.5 |
| 害怕 | 担心 80 · 0.45 / 紧张 40 · 0.35 |
| 驱动 | 困 60 · 0.7 / 饿 50 · 0.5 / 无聊 40 · 0.7 / 累 90 · 0.6 |
| 玩 | 调皮 30 · 0.5 |

半衰期的**方向**有文献依据（例如难过显著长于生气），具体数值为工程取值。
掩饰能力越低，情绪越容易在表达中泄露。

### 5.2 评价维度

情绪由评价维度决定，而非关键词匹配。同一句「你胖」，陌生人与熟人、状态好与状态差时结果不同。

| 维度 | 含义 |
| --- | --- |
| `valence` / `arousal` | 好受程度 / 唤醒程度 |
| `relevance` | 与自身相关程度 |
| `agency` | 归因：`other` / `self` / `world` / `none` |
| `coping` | 可应对程度 |
| `norm` / `fairness` | 越界程度 / 公平程度 |
| `expectation` / `novelty` / `certainty` | 期望落差 / 意外程度 / 确定程度 |
| `intimacy` / `attention` | 关系亲密度 / 受关注程度 |
| `compassion` / `play` / `social` | 共情通道 / 玩笑通道 / 孤独感 |
| `hunger` / `energy` / `load` | 内部驱动：饿 / 困 / 心累 |

数值维度按区间匹配，分类维度按相等匹配；匹配结果加权求和，取最接近的情绪。

### 5.3 性格维度

性格作为情绪动力学的调制参数，可在配置中覆盖基线值（0–100）。

| 维度 | 默认 | 作用 |
| --- | --- | --- |
| `openness` | 62 | 对新事物与空闲行为的倾向 |
| `conscientiousness` | 38 | 行为节制程度 |
| `extraversion` | 58 | 主动发起交互的倾向 |
| `agreeableness` | 52 | 顺从与配合倾向 |
| `neuroticism` | 60 | 负性情绪衰减速度与情绪切换难度 |
| `selfEsteem` | 55 | 对评价的敏感程度 |

### 5.4 动力学

| 机制 | 实现 |
| --- | --- |
| 衰减 | 双指数：先快速下降，随后保留长尾 |
| 续命 | 峰值 > 50 的情绪在降至峰值一半时可回补，至多 3 次 |
| 习惯化 | 同一刺激重复出现时效果递减；短时间内连续出现则升级 |
| 情绪惯性 | 不对称：负性事件易覆盖正性状态，反之较难 |
| 消极偏差 | 负性评价的权重高于同等强度的正性评价 |
| 底色回归 | 心情底色在约 5 小时内回归作息基线 |
| 底色冲击上限 | 单次事件对底色的影响不超过 22 分 |
| 掩饰 | 掩饰能力低的情绪会在表达参数中体现；`show: false` 时仅记录不表达 |

---

## 6. 配置

默认值定义于 `plugin.js` 的 `DEFAULTS`。在 profile 的 `cordis.patch.yml` 中按需覆盖，配置为深合并：

```yaml
- id: fish-mood
  config:
    identity: 你是这个角色本人;情绪是真的,不是演出来的。
    channels:
      qq: true
      web: false
    heartbeat:
      everyMinutes: 15
      lifeChance: 0.05
    feel:
      maxPerHour: 2
    traits:
      neuroticism: 70
```

| 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `stateDir` | string | `~/.dsh/fish-mood` | 状态目录 |
| `promptEnabled` | boolean | `true` | 是否注入提示词段（为 `false` 时工具仍可用） |
| `identity` | string | 见 `lib/prompt.js` | 状态块中用于重述身份的一句话；留空使用默认文案 |
| `channels.qq` | boolean | `true` | 是否对 QQ 会话注入 |
| `channels.web` | boolean | `true` | 是否对 Web / 桌面会话注入 |
| `channels.unknown` | boolean | `false` | 无法判定来源时的行为 |
| `react.enabled` | boolean | `true` | 是否从会话消息推导情绪 |
| `react.maxPerTurn` | number | `2` | 单轮最多识别的消息条数 |
| `react.cooldownMin` | number | `4` | 同一会话两次冲量的最小间隔（分钟） |
| `react.strongCooldownMin` | number | `2` | 强触发事件的最小间隔（分钟） |
| `react.freshMinutes` | number | `15` | 仅处理该时间窗内的新消息 |
| `heartbeat.enabled` | boolean | `true` | 心跳总开关 |
| `heartbeat.everyMinutes` | number | `10` | 心跳周期（分钟） |
| `heartbeat.lifeChance` | number | `0.1` | 每个周期触发小事事件的概率 |
| `heartbeat.minGapMinutes` | number | `45` | 两次小事事件的最小间隔（分钟） |
| `heartbeat.rumination` | boolean | `true` | 反刍（未消化事件重新浮现） |
| `heartbeat.moodRepair` | boolean | `true` | 心情修复 |
| `heartbeat.review` | boolean | `true` | 深夜自动复盘 |
| `feel.maxPerHour` | number | `4` | `mood_feel` 每小时配额 |
| `feel.maxPerDay` | number | `12` | `mood_feel` 每日配额 |
| `feel.maxJump` | number | `25` | 单次记录的最大强度增量 |
| `feel.cooldownMin` | number | `2` | 两次记录的最小间隔（分钟） |
| `traits` | object | `{}` | 覆盖性格基线，例如 `{ neuroticism: 70 }` |

---

## 7. 工作原理

### 7.1 提示词分段

插件向系统提示词注入两个片段，拆分目的是保持提示缓存有效：

| 片段 | order | 内容 | 约束 |
| --- | --- | --- | --- |
| `fish-mood:rules` | 100 | 使用规则、禁止事项、危机处理指引 | 字节级不变，不包含时间与数值 |
| `fish-mood:now` | 9800 | 当前状态块 | 固定模板与字段顺序，置于提示词末尾 |

状态块输出的是**行为约束**（长度、是否主动、语气）而非情绪形容词，避免模型直接复述情绪。
渲染函数包裹在异常处理中，失败时返回空片段，不影响提示词整体组装。

### 7.2 处理链路

```
入站消息
  └─ 评价引擎（18 个维度 → 情绪签名匹配）
       └─ 状态机（强度、习惯化、惯性、底色、关系、记忆）
            └─ 提示词状态块（语气与回复参数）

心跳（默认每 10 分钟）
  └─ 衰减 → 小事事件 → 反刍 → 心情修复 → 深夜复盘
```

心跳是唯一产生随机事件的环节；提示词渲染在每个模型步骤都会执行，不在其中引入随机性。

### 7.3 渠道判定

插件按会话来源决定是否注入：QQ 机器人的入站消息不含 `rpcId`，Web 与桌面客户端消息含 `rpcId`。
无法判定时按 `channels.unknown` 处理（默认关闭）。

### 7.4 状态文件

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/fish-mood/state.json` | 账本（v2）：情绪、心情、性格、关系、日记、会话、统计、标记 |
| `~/.dsh/fish-mood/audit.jsonl` | 审计日志：每次情绪变动一行，用于复盘单调上升等异常 |
| `~/.dsh/fish-mood/load.log` | 加载痕迹：确认运行中的版本（`rev`） |

账本采用原子写入；v1 账本在读取时自动升级（字段归一化），不会渲染出空值。

---

## 8. 运维与故障排查

```powershell
node tools/fake-host.mjs        # 端到端自检（契约、评价、动力学、工具、迁移、异常输入）
node tools/check-rules.mjs      # 触发规则与情绪的映射对照
node tools/preview.mjs          # 查看当前渲染出的状态块
node tools/probe-mood.mjs       # 校验运行中的宿主是否已加载插件
node tools/install.mjs --check  # 安装状态检查
node tools/simulate.mjs --days 7 --report report.md   # 快进模拟并输出指标报告
node tools/simulate.mjs --sections                    # 查看某日的心情曲线与提示词片段
```

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 工具未注册 | 插件未安装或未重载 | 检查 profile 的 `bundles` 与 `cordis.patch.yml`，重启 DSH |
| 提示词中没有状态块 | 渠道未启用；`promptEnabled` 为 `false` | 检查 `channels` 配置与账本中的会话记录 |
| 情绪长期不变化 | 消息未被识别；心跳关闭 | 检查 `react.enabled` 与 `heartbeat.enabled`；用 `preview.mjs` 查看状态 |
| 修改源码后未生效 | 热重载存在延迟；ESM 模块缓存 | 重启 DSH；`mood_now action=diag` 的 `rev` 可确认运行版本 |
| 状态块渲染失败 | 渲染函数异常 | 该片段会被跳过并写入 warn 日志，其余提示词不受影响 |

账本包含日记与关系记录，不建议手工编辑；删除会导致历史状态丢失。

---

## 9. 安全与隐私

- **网络访问**：本插件不发起任何网络请求。
- **凭据**：不使用任何 API Key 或外部服务凭据。
- **数据落盘**：状态、审计日志与加载痕迹均位于本地 `stateDir`。
- **数据外发**：情绪状态会作为系统提示词的一部分进入模型上下文，其内容受所用模型服务条款约束。
- **内容读取**：为推导情绪，会读取会话中的用户消息（默认仅最近 15 分钟内、单轮至多 2 条）。
- **危机处理**：检测到严重负面表达时，注入优先提示，要求模型直接回应并引导寻求现实帮助
  （紧急情况 120 / 110，全国心理援助热线 12356）。

---

## 10. 已知限制

- 情绪状态仅影响表达方式，不改变事实判断与结论。
- 情绪推导基于启发式规则与关键词触发（25 条规则），不做语义级理解，存在误判。
- 状态为单实例内存加文件存储，多进程并行运行同一状态目录时可能产生覆盖。
- 心跳依赖宿主定时器；宿主未运行时不会推进时间演化。
- 情绪目录中的半衰期为工程取值，非实验测量结果。

---

## 11. 开发

### 11.1 目录结构

```
plugin.js              插件入口：提示词分段、工具注册、心跳、会话判定
lib/catalog.js         36 种情绪：半衰期、掩饰能力、评价签名、语气规则、标签
lib/appraise.js        评价引擎：维度打分与情绪匹配
lib/state.js           状态机：衰减、冲量、反刍、修复、复盘、关系账、迁移
lib/react.js           25 条触发规则：消息 → 评价 → 冲量
lib/prompt.js          静态规则段、实时状态块、报告渲染
tools/                 安装、自检、规则校验、模拟、预览与诊断脚本
locale/{zh,en}.json    插件市场展示信息
```

### 11.2 本地验证

```powershell
node tools/fake-host.mjs        # 完整自检
node tools/check-rules.mjs      # 规则映射
node tools/simulate.mjs --days 7
```

提交前请确保上述脚本通过。

---

## 12. 许可证

[MIT](LICENSE)

---

## English Overview

**dsh-fish-mood** gives a DeepSeek Harness agent an emotional state that evolves over time.
It ships a catalogue of 36 emotions with individual half-lives and masking strengths, an appraisal
engine that derives the current emotion from 18 dimensions rather than keyword matching, a baseline
mood that follows the time of day, per-group and per-person relationship tracking, and idle life
events on a heartbeat timer.

The state is injected into the system prompt as two sections — a byte-stable rules section and a
fixed-template live state section — and influences reply tone and length only. Three tools are
registered: `mood_now`, `mood_feel` and `mood_diary`. When severe distress is detected, a priority
block overrides the emotional state with direct, non-performative guidance.

```bash
dsh plugin --profile web add github:ChencLi819/dsh-fish-mood
```

Requirements: DSH `>= 0.1.7-rc.1`, Node.js `>= 22.13.0`, no third-party dependencies.
Licensed under the MIT License.
