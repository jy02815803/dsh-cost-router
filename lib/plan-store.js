/**
 * 已确认方案的短期存储。
 *
 * `plan` 与 `run` 分两步是刻意设计：用户必须在花钱前看到方案。若 `run` 再拆一次，
 * 执行内容就可能与用户确认的内容不同，而且会重复付一次分解费。因此这里把完整
 * 方案、模型目录快照和路由参数按 `planId` 存起来，由 `run` 校验后复用。
 *
 * 方案只保存在当前 Harness 进程里：它不是长期账本，也不写任务正文到磁盘。
 * 进程重启后旧 `planId` 自然失效，调用方重新 `plan` 即可。
 *
 * @module dsh-cost-router/plan-store
 */

import { createHash, randomUUID } from 'node:crypto'

/** 默认最多保留的方案数，避免长会话无限增长。 */
const DEFAULT_LIMIT = 32

/** 给方案签名，防止调用方修改确认后的子任务、模型或预算。 */
function fingerprint(record) {
  const normalized = {
    task: record.task,
    mode: record.mode,
    catalog: record.catalog,
    subtasks: record.subtasks ?? null,
    synthesisModel: record.synthesisModel ?? null,
    plan: record.plan ?? null,
    freeOnly: record.freeOnly === true,
    maxMultiplier: Number.isFinite(record.maxMultiplier) ? record.maxMultiplier : null,
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

/**
 * 一个进程内的方案仓库。
 */
export class PlanStore {
  /**
   * @param {object} [options] - store options.
   * @param {number} [options.limit] - maximum retained plans.
   * @param {() => string} [options.idFactory] - injectable id factory for tests.
   */
  constructor(options = {}) {
    this.limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_LIMIT
    this.idFactory = typeof options.idFactory === 'function' ? options.idFactory : randomUUID
    /** @type {Map<string, object>} */
    this.plans = new Map()
  }

  /**
   * 保存方案并返回稳定的 `planId`。
   *
   * @param {object} input - plan record.
   * @returns {string} plan id.
   */
  save(input) {
    const id = `plan_${this.idFactory()}`
    const record = {
      id,
      createdAt: new Date().toISOString(),
      version: 1,
      task: String(input.task || ''),
      mode: input.mode,
      catalog: input.catalog,
      subtasks: Array.isArray(input.subtasks) ? structuredClone(input.subtasks) : null,
      synthesisModel: input.synthesisModel ?? null,
      plan: input.plan ?? null,
      estCost: Number(input.estCost ?? 0),
      freeOnly: input.freeOnly === true,
      maxMultiplier: Number.isFinite(input.maxMultiplier) ? input.maxMultiplier : null,
      signature: '',
    }
    record.signature = fingerprint(record)
    this.plans.set(id, record)
    while (this.plans.size > this.limit) {
      const oldest = this.plans.keys().next().value
      if (oldest === undefined) break
      this.plans.delete(oldest)
    }
    return id
  }

  /**
   * 校验并读取方案。任何不一致都拒绝执行，不静默降级成重新拆解。
   *
   * @param {string} planId - id returned by `save`.
   * @param {object} expected - values supplied to `run`.
   * @returns {object} validated immutable record copy.
   */
  consume(planId, expected = {}) {
    const id = String(planId || '')
    const record = this.plans.get(id)
    if (!record) throw new Error('方案不存在或已过期，请重新调用 cost_router_plan。')
    if (record.signature !== fingerprint(record)) throw new Error('方案签名校验失败，请重新调用 cost_router_plan。')
    if (String(expected.task || '').trim() !== record.task) {
      throw new Error('任务内容与已确认方案不一致，请重新调用 cost_router_plan。')
    }
    const expectedFreeOnly = expected.freeOnly === true
    const expectedMax = Number.isFinite(expected.maxMultiplier) ? expected.maxMultiplier : null
    if (record.freeOnly !== expectedFreeOnly || (record.maxMultiplier ?? null) !== expectedMax) {
      throw new Error('成本护栏与已确认方案不一致，请重新调用 cost_router_plan。')
    }
    this.plans.delete(id)
    return structuredClone(record)
  }

  /** 当前保留的方案数，供诊断与测试使用。 */
  get size() {
    return this.plans.size
  }
}
