/**
 * 离线评测：统计自动研判规则的触发率与「建议拆分」准确率。
 *
 * 运行：node scripts/evaluate-auto-plan.mjs [--json]
 * 纯规则计算，不加载 DSH、不调用模型、不读写用户状态。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify, classifyTurn, isHeterogeneous } from '../lib/router.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataset = JSON.parse(readFileSync(path.join(root, 'config', 'auto-plan-eval.json'), 'utf8'))
if (dataset.schemaVersion !== 1) throw new Error(`不支持的评测集版本：${dataset.schemaVersion}`)

const rows = []
for (const sample of dataset.cases) {
  const text = String(sample.text ?? '')
  const trigger = text.trim().length >= Number(sample.minChars ?? 12)
  const turn = classifyTurn(text)
  const decision = !trigger
    ? 'skip'
    : turn.meta
      ? 'meta'
      : isHeterogeneous(text, classify(text)).yes
        ? 'decompose'
        : 'single'
  const kinds = decision === 'meta' || decision === 'skip' ? [] : classify(text)
  const decompose = decision === 'decompose'
  rows.push({
    id: sample.id,
    language: sample.language,
    trigger,
    decision,
    decompose,
    kinds,
    triggerOk: trigger === (sample.expectTrigger === true),
    decisionOk: decision === (sample.expectDecision ?? (sample.expectDecompose === true ? 'decompose' : 'single')),
    decomposeOk: decompose === (sample.expectDecompose === true),
    kindsOk: JSON.stringify(kinds) === JSON.stringify(sample.expectKinds ?? []),
  })
}

const summary = {
  total: rows.length,
  triggerAccuracy: rows.filter((r) => r.triggerOk).length / rows.length,
  decisionAccuracy: rows.filter((r) => r.decisionOk).length / rows.length,
  decomposeAccuracy: rows.filter((r) => r.decomposeOk).length / rows.length,
  kindsAccuracy: rows.filter((r) => r.kindsOk).length / rows.length,
  falsePositiveDecompose: rows.filter((r) => r.decompose && !(dataset.cases.find((c) => c.id === r.id)?.expectDecompose === true)).length,
  falseNegativeDecompose: rows.filter((r) => !r.decompose && dataset.cases.find((c) => c.id === r.id)?.expectDecompose === true).length,
  byLanguage: {},
}
for (const language of ['zh', 'en']) {
  const subset = rows.filter((r) => r.language === language)
  summary.byLanguage[language] = {
    total: subset.length,
    triggerAccuracy: subset.filter((r) => r.triggerOk).length / subset.length,
    decisionAccuracy: subset.filter((r) => r.decisionOk).length / subset.length,
    decomposeAccuracy: subset.filter((r) => r.decomposeOk).length / subset.length,
    kindsAccuracy: subset.filter((r) => r.kindsOk).length / subset.length,
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ summary, rows }, null, 2))
} else {
  console.log(`评测样本：${summary.total} 条（中文 ${summary.byLanguage.zh.total} / 英文 ${summary.byLanguage.en.total}）`)
  console.log(`触发判定准确率：${(summary.triggerAccuracy * 100).toFixed(1)}%`)
  console.log(`决策类型准确率：${(summary.decisionAccuracy * 100).toFixed(1)}%`)
  console.log(`拆分建议准确率：${(summary.decomposeAccuracy * 100).toFixed(1)}%`)
  console.log(`能力识别准确率：${(summary.kindsAccuracy * 100).toFixed(1)}%`)
  console.log(`拆分误触发：${summary.falsePositiveDecompose}；漏触发：${summary.falseNegativeDecompose}`)
  for (const row of rows.filter((r) => !r.triggerOk || !r.decisionOk || !r.decomposeOk || !r.kindsOk)) {
    console.log(`- ${row.id}: trigger=${row.trigger} decompose=${row.decompose} kinds=${row.kinds.join(',') || '-'}`)
  }
}

// 完成标准：当前评测集必须全对；否则让 CI / npm test 明确失败，不静默放过规则回退。
if (summary.triggerAccuracy !== 1 || summary.decisionAccuracy !== 1 || summary.decomposeAccuracy !== 1 || summary.kindsAccuracy !== 1) {
  process.exitCode = 1
}