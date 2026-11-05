/**
 * 价格来源与估实偏差口径。
 *
 * 本模块刻意区分三件事：渠道明确声明的倍率、模型名启发式推测、完全未知价格。
 * 路由可以使用相对成本做排序，但报告必须告诉用户这些数字有多可信。
 *
 * @module dsh-cost-router/pricing
 */

/** 价格来源：从可靠到不可靠。 */
export const PRICE_SOURCES = {
  DECLARED: 'declared',
  NAME_HEURISTIC: 'name-heuristic',
  DEFAULT: 'default',
  UNKNOWN: 'unknown',
}

/**
 * 汇总目录里的价格来源。
 *
 * @param {object[]} models - catalog models.
 * @returns {{declared: number, heuristic: number, unknown: number}}
 */
export function priceSourceSummary(models = []) {
  const result = { declared: 0, heuristic: 0, unknown: 0 }
  for (const model of models) {
    if (model?.fromCatalog === true) result.declared += 1
    else if (model?.free === true) result.heuristic += 1
    else result.unknown += 1
  }
  return result
}

/**
 * 计算估算值与实耗值的偏差。
 *
 * 两边都为 0 视为完全一致；估算为 0 但实耗非 0 时返回 Infinity，由调用方
 * 在 UI 层显示为「估算不可用」，避免给出假精度。
 *
 * @param {number} estimated - estimated relative cost.
 * @param {number} actual - measured relative cost.
 * @returns {{estimated: number, actual: number, delta: number, ratio: number|null, quality: string}}
 */
export function costDelta(estimated, actual) {
  const e = Number(estimated ?? 0)
  const a = Number(actual ?? 0)
  const delta = Number((a - e).toFixed(6))
  if (e === 0 && a === 0) return { estimated: 0, actual: 0, delta: 0, ratio: 0, quality: 'exact' }
  if (e === 0) return { estimated: 0, actual: a, delta, ratio: null, quality: 'estimate-unavailable' }
  const ratio = Number((Math.abs(delta) / Math.abs(e)).toFixed(4))
  return {
    estimated: e,
    actual: a,
    delta,
    ratio,
    quality: ratio <= 0.1 ? 'good' : ratio <= 0.3 ? 'fair' : 'poor',
  }
}
