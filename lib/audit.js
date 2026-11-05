/**
 * 可选、默认关闭的本地隐私审计。
 *
 * 只记录路由决策的元数据，永不保存任务正文、模型输出、凭据或 token。
 * 不联网，不上传；文件可一键删除。审计失败绝不影响主流程。
 *
 * @module dsh-cost-router/audit
 */

import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

/** 审计文件名，与 state.json 放在同一目录。 */
const FILE_NAME = 'audit.jsonl'

/**
 * 开关必须是**实时**的：界面点一下就立刻生效，不该等重启。
 *
 * 所以 enabled 做成 getter，优先读可变状态对象 `liveState`，而不是在构造时把值
 * 固化到实例上。一旦固化，就会出现「界面显示已开启、磁盘一个字节都没写」的假
 * 开关——免重启设计（见 auto-plan.js 的钩子）要求所有开关口径一致。
 * 两者都传时 liveState 优先；只传 enabled 时退化为静态开关，便于测试。
 *
 * @param {object} [options] - constructor options.
 * @param {string|null} [options.statePath] - state.json path or null.
 * @param {boolean} [options.enabled] - static fallback used when liveState is absent.
 * @param {{auditEnabled?: boolean}} [options.liveState] - mutable runtime state.
 */
export class PrivacyAudit {
  constructor(options = {}) {
    this.liveState =
      options.liveState && typeof options.liveState === 'object' ? options.liveState : null
    this.staticEnabled = options.enabled === true
    this.statePath = typeof options.statePath === 'string' ? options.statePath : null
  }

  /** 当前是否开启审计：实时读 liveState，没有则回落到构造时的静态值。 */
  get enabled() {
    if (this.liveState) return this.liveState.auditEnabled === true
    return this.staticEnabled
  }

  /** 审计文件路径；状态目录不可用时返回 null。 */
  get path() {
    return this.statePath ? path.join(path.dirname(this.statePath), FILE_NAME) : null
  }

  /**
   * 写一条脱敏记录。
   *
   * @param {object} event - decision metadata.
   * @returns {boolean} whether a record was written.
   */
  record(event) {
    if (!this.enabled || !this.path) return false
    const safe = {
      ts: new Date().toISOString(),
      stage: String(event.stage ?? 'unknown').slice(0, 64),
      kinds: Array.isArray(event.kinds) ? event.kinds.map((v) => String(v).slice(0, 32)).slice(0, 12) : [],
      decision: String(event.decision ?? 'unknown').slice(0, 64),
      model: event.model ? String(event.model).slice(0, 120) : null,
      estimated: Number(event.estimated ?? 0),
      actual: Number(event.actual ?? 0),
      quality: String(event.quality ?? 'unknown').slice(0, 32),
      accepted: event.accepted === true,
    }
    // 明确的白名单字段，避免调用方误把任务正文塞进扩展字段。
    try {
      mkdirSync(path.dirname(this.path), { recursive: true })
      appendFileSync(this.path, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', mode: 0o600 })
      return true
    } catch {
      return false
    }
  }

  /** 删除审计文件；不存在时视为成功。 */
  clear() {
    const file = this.path
    if (!file || !existsSync(file)) return true
    try {
      rmSync(file, { force: true })
      return true
    } catch {
      return false
    }
  }
}
