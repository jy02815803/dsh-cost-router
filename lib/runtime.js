/**
 * 同一插件进程内的实例间运行时状态。
 *
 * plan / run 是分开的工具调用，但必须共享「已确认方案」和少量脱敏诊断信息。
 * ESM 模块实例在宿主 loader 里通常稳定；这里显式挂到 globalThis，避免将来
 * 同一插件被复制到多个模块实例时方案丢失。
 *
 * @module dsh-cost-router/runtime
 */

import { PlanStore } from './plan-store.js'

const KEY = Symbol.for('dsh-cost-router.runtime.v1')

/**
 * 取当前进程的共享运行时。
 *
 * @returns {{planStore: PlanStore, lastError: string|null, lastVerdict: object|null, lastPlanCard: object|null, lastRunCard: object|null, startedAt: string}}
 */
export function getRuntime() {
  if (!globalThis[KEY]) {
    globalThis[KEY] = {
      planStore: new PlanStore(),
      lastError: null,
      lastVerdict: null,
      lastPlanCard: null,
      lastRunCard: null,
      startedAt: new Date().toISOString(),
    }
  }
  return globalThis[KEY]
}

/** 记录一条短错误摘要，供诊断页排查；绝不记录任务正文或凭据。 */
export function recordError(error) {
  const runtime = getRuntime()
  runtime.lastError = String(error?.message ?? error ?? 'unknown error').slice(0, 200)
}
