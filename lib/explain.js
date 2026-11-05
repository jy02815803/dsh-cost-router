/**
 * 决策解释卡片。
 *
 * 把规则研判的结果组织成可读、可记录的元数据。这里不输出任务正文，也不调用模型。
 *
 * @module dsh-cost-router/explain
 */

import { priceSourceSummary } from './pricing.js'

/**
 * 生成决策置信度与原因。
 *
 * @param {object} input - decision inputs.
 * @returns {{confidence: string, reasons: string[], warnings: string[]}}
 */
export function explainDecision(input) {
  const reasons = []
  const warnings = []
  const kinds = Array.isArray(input.kinds) ? input.kinds : []
  const distinct = new Set(kinds).size
  if (input.willDecompose === true) {
    reasons.push(`识别到 ${distinct} 类能力，规则判定值得拆分`)
    if (kinds.includes('vision')) reasons.push('包含视觉任务，需要支持图片的模型')
  } else {
    reasons.push('规则判定为同质或简单任务，单模型更连贯也更省')
  }
  if (input.dryRun === true) warnings.push('dryRun 已开启：只记录建议，不会注入提示')
  if (input.freeOnly === true) warnings.push('仅免费模型：能力不足时可能失败，不会自动升级')

  const sources = input.priceSources ?? priceSourceSummary(input.models ?? [])
  if (sources.unknown > 0) warnings.push(`${sources.unknown} 个模型价格来自默认口径，成本估算仅供参考`)
  if (sources.heuristic > 0) warnings.push(`${sources.heuristic} 个模型按名称推断免费，需以渠道账单为准`)

  let confidence = 'medium'
  if (kinds.length === 0) confidence = 'low'
  else if (input.willDecompose === true && kinds.includes('vision') && distinct >= 2) confidence = 'high'
  else if (input.willDecompose === false && distinct <= 1) confidence = 'high'
  return { confidence, reasons, warnings }
}

/**
 * 生成可展示的决策卡片；输出只含元数据，不含任务正文。
 *
 * @param {object} input - decision inputs.
 * @returns {object} decision card.
 */
export function decisionCard(input) {
  const explanation = explainDecision(input)
  return {
    decision: input.willDecompose === true ? 'decompose' : 'single',
    confidence: explanation.confidence,
    reasons: explanation.reasons,
    warnings: explanation.warnings,
    kinds: Array.isArray(input.kinds) ? input.kinds : [],
    priceSources: input.priceSources ?? priceSourceSummary(input.models ?? []),
    estimated: Number(input.estimated ?? 0),
    candidateCount: Array.isArray(input.models) ? input.models.length : 0,
  }
}
