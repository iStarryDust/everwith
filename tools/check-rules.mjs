// 看一眼「触发词 → 评价 → 情绪」这条链现在跑成什么样。
//
// 这张表是调参用的:情绪不再由关键词直接决定,所以改一处评价维度可能牵动好几条规则。
// 同一个触发词会按「陌生人 / 熟人」两种亲密度各跑一遍 —— 熟人的刀更疼,陌生人的话更气人,
// 这是设计里故意的。
//
// 用法:
//   node tools/check-rules.mjs              # 全部规则
//   node tools/check-rules.mjs fat insult   # 只看这几条
//   node tools/check-rules.mjs --json       # 给机器看
import { appraise } from '../lib/appraise.js'
import { RULES } from '../lib/react.js'
import { emptyState } from '../lib/state.js'

const args = process.argv.slice(2)
const json = args.includes('--json')
const only = args.filter((arg) => !arg.startsWith('--'))
const rows = RULES.filter((rule) => !only.length || only.includes(rule.id))

const base = emptyState()
const contexts = [
  { who: '陌生人', closeness: 20 },
  { who: '熟人', closeness: 85 },
]

const out = []
for (const rule of rows) {
  for (const ctx of contexts) {
    const judged = appraise(
      {
        kind: 'message',
        why: rule.why ? rule.why(ctx.who) : '',
        strength: rule.strength,
        dims: rule.dims,
        who: { id: ctx.who, name: ctx.who, closeness: ctx.closeness },
      },
      { traits: base.traits, energy: 0.5, hunger: 0, load: 0 },
    )
    out.push({
      rule: rule.id,
      who: ctx.who,
      emotion: judged.key,
      intensity: judged.intensity,
      runnerUp: judged.runnerUp?.key ?? '',
      dims: judged.dims,
    })
  }
}

if (json) {
  console.log(JSON.stringify(out, null, 2))
} else {
  console.log('规则 → 情绪(左:陌生人 右:熟人)\n')
  const byRule = new Map()
  for (const row of out) {
    if (!byRule.has(row.rule)) byRule.set(row.rule, [])
    byRule.get(row.rule).push(row)
  }
  for (const [rule, list] of byRule) {
    const cells = list.map((row) => `${row.emotion}(${row.intensity}${row.runnerUp ? `,次${row.runnerUp}` : ''})`)
    console.log(`  ${rule.padEnd(14)} ${cells[0].padEnd(24)} ${cells[1]}`)
  }
  const calm = out.filter((row) => row.emotion === 'calm')
  if (calm.length) {
    console.log(`\n⚠ 没推出任何情绪的规则:${calm.map((row) => `${row.rule}/${row.who}`).join(', ')}`)
  }
  const weak = out.filter((row) => row.emotion !== 'calm' && row.intensity < 12)
  if (weak.length) {
    console.log(`⚠ 太淡(<12)的:${weak.map((row) => `${row.rule}/${row.who}=${row.intensity}`).join(', ')}`)
  }
}
