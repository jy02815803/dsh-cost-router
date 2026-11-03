/**
 * cost-router — 编排核心。
 *
 * 三个动作：
 *   plan    研判任务 → 决定要不要拆 → 拆了给出子任务 + 模型分配 + 预估成本（不执行）
 *   run     按方案执行，逐个子任务派给对应模型，最后汇总；返回结果和真实花费
 *   report  查看成本台账
 *
 * 为什么拆 plan / run 两步：让用户在花钱之前能看到方案并改主意。
 * 一次跑完的编排器，用户永远不知道自己被扣了多少。
 *
 * @module dsh-cost-router/orchestrator
 */

import { buildCatalog } from './catalog.js'
import {
  classify,
  estimatePlanCost,
  isHeterogeneous,
  pickModel,
  pickSynthesisModel,
  requiresStrong,
} from './router.js'
import { callModel, usageCost } from './llm.js'

/** 分解提示词。 */
const DECOMPOSE_PROMPT = `你是任务规划器。把用户的任务拆成可以独立执行的子任务。

要求：
1. 只拆"能力不同、需要不同模型"的部分。同一类能力的活合并成一个子任务，不要为了拆而拆。
2. 每个子任务必须说明它需要哪些输入材料，不要把全部材料塞给每个子任务。
3. 标注依赖关系：有前置任务的填 depends_on。
4. 最后一个子任务如果不是"汇总成稿"，就不要硬加。
5. 如果任务里有图片/截图，vision 类的子任务必须排在前面，并且 needs 要写明"需要看图"。

只输出 JSON，不要解释：
{
  "subtasks": [
    {
      "id": "t1",
      "kind": "vision | text | longdoc | reasoning | code | writing | bulk",
      "instruction": "交给执行模型的具体指令，要能独立看懂",
      "needs": "这个子任务需要哪些输入材料（描述即可）",
      "depends_on": []
    }
  ]
}`

/** 子任务执行者的系统提示。 */
const EXECUTOR_PROMPT = `你是任务执行器，只完成下面这一件事，输出直接可用的结果，不要寒暄、不要解释你在做什么。
子任务类型：{kind}`

/** 汇总者的系统提示。 */
const SYNTHESIS_PROMPT = `你把多个模型分别完成的片段合并成一份完整成果。要求：统一口径和文风，去掉重复，逻辑连贯，不要暴露"这是多个模型拼的"。直接输出成品。`

/** 依赖产出带入下游时的截断上限（字符）。 */
const UPSTREAM_LIMIT = 6000

/** 账本条目上限（见 track() 里的说明）。 */
const LEDGER_LIMIT = 500

/**
 * 预算检查的预留额度（相对成本单位）。
 *
 * 分解/单跑的调用金额要到真跑完才知道，所以检查预算时先按这个经验值预留，
 * 避免"预算刚好够、结果超支"。它是保险丝，不是精确估值。
 */
const RESERVE_SINGLE = 0.05
const RESERVE_DECOMPOSED = 0.1

/**
 * 组装一条带图片的用户消息。
 *
 * 图片块是 DSH 的持久附件引用（attachmentId / mediaType / 宽高），提供方
 * 适配器会按路由显式选定的目标尺寸投影它们，所以这里直接复用会话里的引用，
 * 不自己 base64 搬运。
 *
 * @param {string} text - the text part.
 * @param {Array<object>} images - image blocks.
 * @returns {object} a request message.
 */
function userMessageWithImages(text, images) {
  return {
    role: 'user',
    content: [...images, { type: 'text', text }],
  }
}

/** 编排器：持有一份账本，暴露 plan / run / report。 */
export class Orchestrator {
  /**
   * @param {object} ctx - Cordis context carrying `llm` and optionally `settings`.
   * @param {object} policy - routing policy (floors, capability overrides, synthesis model).
   * @param {object} [options] - runtime options.
   */
  constructor(ctx, policy, options = {}) {
    this.ctx = ctx
    this.policy = policy ?? {}
    this.options = options
    /** @type {Array<object>} 每一次模型调用的记录（只保留最近 LEDGER_LIMIT 条）。 */
    this.ledger = []
    /**
     * @type {number} **本次 run** 的累计相对成本，每次 plan/run 开始时归零。
     *
     * 只服务预算熔断：budget 承诺的是「这次任务最多花多少」。跨 run 复用它
     * 会把上一次任务花的钱算进来，用户会看到莫名其妙的「预算不足」。
     */
    this.totalCost = 0
    /**
     * @type {number} **本次会话累计**相对成本，永不归零，供 report 台账使用。
     *
     * 必须与 totalCost 分开：totalCost 会被 beginRun 归零，若直接拿它当台账
     * 合计，report 的数字就会随「最近跑了几个任务」漂移，还会和 byModel 的
     * 逐模型合计对不上。
     */
    this.sessionCost = 0
    /**
     * @type {number} 本次会话的调用次数，永不归零。
     *
     * 不用 ledger.length 代替：账本有 LEDGER_LIMIT 条上限，长会话里会被裁剪，
     * 拿它当计数会把"一共调了多少次"算少。
     */
    this.sessionCalls = 0
    /** @type {number} 本轮 plan/run 的调用次数，每次 beginRun 归零。 */
    this.runCalls = 0
    /** @type {number|null} 预算上限（相对成本单位）。 */
    this.budgetCap = null
  }

  /**
   * 开始一次新的 plan/run：给这次运行编号，并把本轮预算与累计成本归零。
   *
   * 为什么必须隔离：budgetCap 是"这次任务最多花多少"的承诺。如果跨 run 复用，
   * 第二次 run 会拿上一次已花的钱去卡预算，用户会看到莫名其妙的"预算不足"。
   *
   * runId 的作用是把账本切成"按次"的切片：同一实例连跑多个任务时，report 要
   * 看会话累计，run 的结果只要本轮花费，两者靠这个编号分开。
   *
   * @param {number|undefined} budget - 本轮预算上限（相对成本单位）。
   * @returns {void}
   */
  beginRun(budget) {
    this.runId = (this.runId ?? 0) + 1
    this.totalCost = 0
    this.runCalls = 0
    const cap = Number(budget)
    this.budgetCap = Number.isFinite(cap) ? cap : null
  }

  /**
   * 把一次调用记进账本。
   *
   * @param {object} entry - call record fields.
   * @returns {object} the recorded entry.
   */
  track(entry) {
    const record = {
      ts: new Date().toISOString(),
      runId: this.runId ?? 0,
      stage: entry.stage,
      provider: entry.provider,
      model: entry.model,
      inTok: entry.inTok ?? 0,
      outTok: entry.outTok ?? 0,
      cost: entry.cost ?? 0,
      durationMs: entry.durationMs ?? 0,
      ...(entry.subtaskId ? { subtaskId: entry.subtaskId } : {}),
      ...(entry.failure ? { failure: entry.failure } : {}),
    }
    this.ledger.push(record)
    this.totalCost = Number((this.totalCost + record.cost).toFixed(6))
    this.sessionCost = Number((this.sessionCost + record.cost).toFixed(6))
    this.sessionCalls += 1
    this.runCalls += 1
    // 只保留最近 LEDGER_LIMIT 条，防止长会话里账本无限增长。totalCost 与
    // sessionCost 都是独立累加的，被裁掉的只是明细，合计口径依然正确。
    if (this.ledger.length > LEDGER_LIMIT) this.ledger.splice(0, this.ledger.length - LEDGER_LIMIT)
    return record
  }

  /**
   * 校验预算。超了直接拒绝，不花钱。
   *
   * @param {number} estimated - estimated additional cost.
   * @returns {void}
   */
  checkBudget(estimated) {
    if (this.budgetCap === null || this.budgetCap === undefined) return
    if (this.totalCost + estimated > this.budgetCap) {
      throw new Error(
        `预算不足：已花 ${this.totalCost.toFixed(4)}，本次还需约 ${estimated.toFixed(4)}，` +
        `超出上限 ${this.budgetCap.toFixed(4)}。调高 budget 或缩小任务范围。`,
      )
    }
  }

  /**
   * 取得一次运行的模型目录快照。
   *
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object>} catalog snapshot.
   */
  async catalog(signal) {
    return buildCatalog(this.ctx, {
      ...(this.options.onlyProviders ? { onlyProviders: this.options.onlyProviders } : {}),
      ...(signal ? { signal } : {}),
    })
  }

  /**
   * 研判任务，决定拆不拆，并给出方案。
   *
   * @param {object} args - tool arguments.
   * @param {AbortSignal} [args.signal] - cancellation.
   * @returns {Promise<object>} the plan.
   */
  async plan(args) {
    const task = String(args.task || '').trim()
    if (!task) throw new Error('task 不能为空')
    this.beginRun(args.budget)

    const catalog = await this.catalog(args.signal)
    if (catalog.models.length === 0) {
      throw new Error('cost-router 没有发现任何可用模型。请先在 DSH 里配置至少一个模型渠道。')
    }

    const kinds = classify(task)
    const hetero = isHeterogeneous(task, kinds)
    const strong = requiresStrong(task)

    if (!hetero.yes) {
      const kind = kinds[0] || 'reasoning'
      const model = pickModel(kind, catalog, this.policy, { forceStrong: strong })
      return {
        mode: 'single',
        verdict: '不拆',
        reason: hetero.why,
        detectedKinds: kinds,
        model: model ? `${model.provider}/${model.model}` : '(无可用模型)',
        modelName: model?.name,
        free: model?.free ?? false,
        costMultiplier: model?.costMultiplier,
        note: '单模型直做。拆开反而多付分解费和汇总费，还会让文风断裂。',
        next: '直接执行，或调 run 让它按这个结论跑。',
      }
    }

    const subtasks = await this.decompose(task, catalog, args.signal)
    const rows = subtasks.map((subtask) => {
      const model = pickModel(subtask.kind, catalog, this.policy)
      return {
        id: subtask.id,
        kind: subtask.kind,
        model: model ? `${model.provider}/${model.model}` : '(无可用模型)',
        modelName: model?.name,
        free: model?.free ?? false,
        costMultiplier: model?.costMultiplier,
        depends_on: (subtask.depends_on || []).join(',') || '-',
        instruction: String(subtask.instruction || '').slice(0, 60) + '…',
      }
    })

    const synthesis = pickSynthesisModel(catalog, this.policy)
    const estimate = estimatePlanCost(subtasks, catalog, this.policy, task)

    return {
      mode: 'decomposed',
      verdict: '拆',
      reason: hetero.why,
      detectedKinds: kinds,
      subtasks: rows,
      synthesisModel: synthesis ? `${synthesis.provider}/${synthesis.model}` : '(无可用模型)',
      estCost: estimate,
      estCostNote: '相对成本，以标准价模型跑同等 token 为 1.0；免费模型记 0。',
      warning: subtasks.length > 6
        ? `拆成了 ${subtasks.length} 个子任务，可能过细，汇总时容易丢信息，建议合并`
        : null,
      next: '确认后调 run 执行。要改分配就调整 policy 的 capabilityOverrides。',
    }
  }

  /**
   * 让规划模型分解任务。
   *
   * @param {string} task - task description.
   * @param {object} catalog - catalog snapshot.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object[]>} planned subtasks.
   */
  async decompose(task, catalog, signal) {
    // 分解是整个流程里最吃脑子的活，必须用中档以上模型，不能用最便宜的。
    const planner = pickModel('reasoning', catalog, this.policy, { forceStrong: true })
    if (!planner) throw new Error('没有可用于分解的模型。')

    const result = await callModel(this.ctx, planner, [
      { role: 'user', content: [{ type: 'text', text: task }] },
    ], {
      system: DECOMPOSE_PROMPT,
      temperature: 0.2,
      maxTokens: 2000,
      ...(signal ? { signal } : {}),
    })

    this.track({
      stage: 'decompose',
      provider: planner.provider,
      model: planner.model,
      inTok: result.usage.inputTokens,
      outTok: result.usage.outputTokens,
      cost: usageCost(planner, result.usage),
      durationMs: result.durationMs,
      ...(result.failure ? { failure: result.failure } : {}),
    })

    if (result.failure) {
      throw new Error(`分解失败（${result.failure}）：${result.text.slice(0, 200) || '模型没有返回内容'}`)
    }

    let plan
    try {
      plan = JSON.parse(result.text)
    } catch {
      const match = result.text.match(/\{[\s\S]*\}/)
      if (!match) throw new Error(`分解结果不是合法 JSON：${result.text.slice(0, 200)}`)
      plan = JSON.parse(match[0])
    }
    if (!Array.isArray(plan.subtasks) || plan.subtasks.length === 0) {
      throw new Error('分解结果没有子任务')
    }

    // 补齐字段并规整依赖。
    const seen = new Set()
    return plan.subtasks.map((subtask, index) => {
      let id = String(subtask.id || `t${index + 1}`)
      while (seen.has(id)) id = `${id}-${index + 1}`
      seen.add(id)
      const depends = Array.isArray(subtask.depends_on)
        ? subtask.depends_on.map((d) => String(d)).filter((d) => d !== id)
        : []
      return {
        id,
        kind: String(subtask.kind || 'text'),
        instruction: String(subtask.instruction || ''),
        needs: String(subtask.needs || ''),
        depends_on: depends,
      }
    })
  }

  /**
   * 执行一次编排。
   *
   * @param {object} args - tool arguments.
   * @param {AbortSignal} [args.signal] - cancellation.
   * @param {Array<object>} [args.images] - image blocks to carry into subtasks.
   * @returns {Promise<object>} the run result.
   */
  async run(args) {
    const task = String(args.task || '').trim()
    if (!task) throw new Error('task 不能为空')
    this.beginRun(args.budget)

    const catalog = await this.catalog(args.signal)
    if (catalog.models.length === 0) {
      throw new Error('cost-router 没有发现任何可用模型。请先在 DSH 里配置至少一个模型渠道。')
    }

    const kinds = classify(task)
    const hetero = isHeterogeneous(task, kinds)
    const strong = requiresStrong(task)

    // 不拆：直接派给最合适的模型。
    if (!hetero.yes) {
      const kind = kinds[0] || 'reasoning'
      const model = pickModel(kind, catalog, this.policy, { forceStrong: strong })
      if (!model) throw new Error(`没有能处理 ${kind} 类型任务的模型`)
      this.checkBudget(RESERVE_SINGLE)

      const result = await callModel(this.ctx, model, [
        { role: 'user', content: [{ type: 'text', text: task }] },
      ], {
        temperature: 0.4,
        ...(args.signal ? { signal: args.signal } : {}),
      })
      this.track({
        stage: 'single',
        provider: model.provider,
        model: model.model,
        inTok: result.usage.inputTokens,
        outTok: result.usage.outputTokens,
        cost: usageCost(model, result.usage),
        durationMs: result.durationMs,
        ...(result.failure ? { failure: result.failure } : {}),
      })
      if (result.failure) throw new Error(`模型调用失败（${result.failure}）`)

      return {
        mode: 'single',
        output: result.text,
        model: `${model.provider}/${model.model}`,
        cost: this.summary(),
      }
    }

    const subtasks = await this.decompose(task, catalog, args.signal)
    this.checkBudget(RESERVE_DECOMPOSED)

    const results = await this.runSubtasks(subtasks, task, catalog, args.signal, args.images)
    const final = await this.synthesize(subtasks, results, task, catalog, args.signal)

    return {
      mode: 'decomposed',
      subtaskCount: subtasks.length,
      assignment: subtasks.map((s) => {
        const model = pickModel(s.kind, catalog, this.policy)
        return `${s.id}(${s.kind}) → ${model ? `${model.provider}/${model.model}` : '(无可用模型)'}`
      }),
      output: final,
      cost: this.summary(),
    }
  }

  /**
   * 逐个执行子任务，无依赖的并行。
   *
   * 失败隔离：单个子任务失败不会让整批崩掉。失败的子任务标记为失败，
   * 其下游仍然执行（用「上游失败」提示），汇总环节能识别缺口。
   *
   * @param {object[]} subtasks - planned subtasks.
   * @param {string} task - overall task text.
   * @param {object} catalog - catalog snapshot.
   * @param {AbortSignal} [signal] - cancellation.
   * @param {Array<object>} [images] - image blocks carried into subtasks.
   * @returns {Promise<object>} map of subtask id → result record.
   */
  async runSubtasks(subtasks, task, catalog, signal, images) {
    const results = {}
    const done = new Set()
    let guard = 0

    while (done.size < subtasks.length && guard++ < subtasks.length * 3) {
      const ready = subtasks.filter(
        (s) => !done.has(s.id) && (s.depends_on || []).every((d) => done.has(d)),
      )
      if (ready.length === 0 && done.size < subtasks.length) {
        // 依赖成环：剩下的标记失败，不无限循环。
        for (const s of subtasks) {
          if (done.has(s.id)) continue
          results[s.id] = { ok: false, text: '', error: '子任务依赖成环，无法执行' }
          done.add(s.id)
        }
        break
      }

      // allSettled：单个子任务失败不拖垮整批。
      const settled = await Promise.allSettled(
        ready.map((subtask) => this.runOne(subtask, task, catalog, results, signal, images)),
      )

      for (let i = 0; i < settled.length; i++) {
        const subtask = ready[i]
        const outcome = settled[i]
        if (outcome.status === 'fulfilled') {
          results[subtask.id] = outcome.value
        } else {
          results[subtask.id] = {
            ok: false,
            text: '',
            error: outcome.reason?.message ?? String(outcome.reason),
          }
        }
        done.add(subtask.id)
      }
    }

    return results
  }

  /**
   * 执行一个子任务。
   *
   * 上下文隔离是省钱的关键：每个子任务只带自己需要的材料，不把全文复制给每一路。
   *
   * @param {object} subtask - one subtask.
   * @param {string} task - overall task text.
   * @param {object} catalog - catalog snapshot.
   * @param {object} upstream - already-completed subtask results.
   * @param {AbortSignal} [signal] - cancellation.
   * @param {Array<object>} [images] - image blocks carried into subtasks.
   * @returns {Promise<object>} the subtask result record.
   */
  async runOne(subtask, task, catalog, upstream, signal, images) {
    const model = pickModel(subtask.kind, catalog, this.policy)
    if (!model) {
      return { ok: false, text: '', error: `没有能处理 ${subtask.kind} 类型任务的模型`, model: null }
    }

    // 上游产出：只带被依赖的那几项，且截断。
    const parts = []
    for (const dep of subtask.depends_on || []) {
      const prior = upstream[dep]
      if (!prior) {
        parts.push(`【${dep} 的产出】\n（上游子任务失败，没有可用产出）`)
        continue
      }
      const text = String(prior.text || '').slice(0, UPSTREAM_LIMIT)
      parts.push(`【${dep} 的产出】\n${text}`)
    }

    const prompt = [
      `你的子任务：${subtask.instruction}`,
      subtask.needs ? `所需材料：${subtask.needs}` : '',
      parts.length > 0 ? `上游产出：\n${parts.join('\n\n')}` : '',
    ].filter(Boolean).join('\n\n')

    // 图片只在视觉类子任务上携带：其他子任务带图是纯浪费 token。
    const carryImages = subtask.kind === 'vision' && Array.isArray(images) ? images : []

    const result = await callModel(this.ctx, model, [
      carryImages.length > 0
        ? userMessageWithImages(prompt, carryImages)
        : { role: 'user', content: [{ type: 'text', text: prompt }] },
    ], {
      system: EXECUTOR_PROMPT.replace('{kind}', subtask.kind),
      temperature: 0.4,
      ...(signal ? { signal } : {}),
    })

    this.track({
      stage: subtask.id,
      subtaskId: subtask.id,
      provider: model.provider,
      model: model.model,
      inTok: result.usage.inputTokens,
      outTok: result.usage.outputTokens,
      cost: usageCost(model, result.usage),
      durationMs: result.durationMs,
      ...(result.failure ? { failure: result.failure } : {}),
    })

    if (result.failure) {
      return { ok: false, text: '', error: `模型调用失败（${result.failure}）`, model }
    }
    return { ok: true, text: result.text, error: null, model }
  }

  /**
   * 汇总各子任务产出。
   *
   * 汇总模型必须够强，否则只会机械拼接——所以这里用 pickSynthesisModel，
   * 它按能力选而不是按成本选。
   *
   * @param {object[]} subtasks - planned subtasks.
   * @param {object} results - subtask results.
   * @param {string} task - overall task text.
   * @param {object} catalog - catalog snapshot.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<string>} the final output.
   */
  async synthesize(subtasks, results, task, catalog, signal) {
    if (subtasks.length === 1) {
      const only = results[subtasks[0].id]
      return only?.text ?? ''
    }

    const writer = pickSynthesisModel(catalog, this.policy)
    if (!writer) {
      // 没有可用汇总模型时，拼接而不静默丢掉内容。
      return subtasks
        .map((s) => results[s.id]?.text || '')
        .filter(Boolean)
        .join('\n\n---\n\n')
    }

    const parts = subtasks.map((s) => {
      const r = results[s.id]
      if (!r?.ok) return `【${s.id} / ${s.kind}】\n（本子任务失败：${r?.error ?? '未知原因'}）`
      return `【${s.id} / ${s.kind}】\n${r.text}`
    }).join('\n\n---\n\n')

    const result = await callModel(this.ctx, writer, [
      {
        role: 'user',
        content: [{ type: 'text', text: `原始任务：${task}\n\n各部分产出：\n\n${parts}` }],
      },
    ], {
      system: SYNTHESIS_PROMPT,
      temperature: 0.4,
      ...(signal ? { signal } : {}),
    })

    this.track({
      stage: 'synthesize',
      provider: writer.provider,
      model: writer.model,
      inTok: result.usage.inputTokens,
      outTok: result.usage.outputTokens,
      cost: usageCost(writer, result.usage),
      durationMs: result.durationMs,
      ...(result.failure ? { failure: result.failure } : {}),
    })

    if (result.failure) {
      // 汇总失败时退回拼接，不丢内容。
      return parts
    }
    return result.text
  }

  /**
   * 生成成本台账摘要。
   *
   * 有两个口径，靠 `scope` 区分：
   *  - `'run'`（默认）：只看**本轮** plan/run 的调用。plan()/run() 的返回值用这个，
   *    因为用户问的是"这次任务花了多少"。
   *  - `'session'`：整个 Orchestrator 生命周期（= 一次会话）的累计。report 工具用这个。
   *
   * 两个口径都不能直接从 totalCost 读：totalCost 会被 beginRun 归零，只适合本轮。
   *
   * @param {object} [options] - summary options.
   * @param {boolean} [options.detail] - include the per-call breakdown.
   * @param {'run'|'session'} [options.scope] - which ledger slice to summarize.
   * @returns {object} the summary.
   */
  summary(options = {}) {
    const scope = options.scope === 'session' ? 'session' : 'run'
    const entries = scope === 'session'
      ? this.ledger
      : this.ledger.filter((entry) => entry.runId === (this.runId ?? 0))

    const byModel = new Map()
    for (const entry of entries) {
      const key = `${entry.provider}/${entry.model}`
      const current = byModel.get(key) ?? { model: key, calls: 0, inTok: 0, outTok: 0, cost: 0 }
      current.calls += 1
      current.inTok += entry.inTok
      current.outTok += entry.outTok
      current.cost = Number((current.cost + entry.cost).toFixed(6))
      byModel.set(key, current)
    }

    // 合计与次数都用独立计数器，不用 entries 汇总：
    // 账本会被 LEDGER_LIMIT 裁剪，按 entries 算会漏掉被裁掉的调用。
    const totalCost = scope === 'session' ? this.sessionCost : this.totalCost
    const callCount = scope === 'session' ? this.sessionCalls : this.runCalls

    const base = {
      scope,
      totalCost,
      calls: callCount,
      byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
      note: scope === 'session'
        ? '相对成本，以标准价模型跑同等 token 为 1.0；免费模型记 0。totalCost 为本次会话累计。'
        : '相对成本，以标准价模型跑同等 token 为 1.0；免费模型记 0。totalCost 为最近一次任务的累计。',
      // 明细被裁掉时提示：合计口径不受影响，但 breakdown 不完整。
      ...(scope === 'session' && this.ledger.length >= LEDGER_LIMIT ? { truncated: true } : {}),
      // 明细条数少于调用次数，说明 breakdown 不完整（合计仍然准确）。
      ...(entries.length !== callCount ? { truncated: true } : {}),
    }

    if (!options.detail) return base

    return {
      ...base,
      breakdown: entries.map((e) => {
        const parts = [`${e.stage}: ${e.provider}/${e.model} ${e.inTok}+${e.outTok} tok = ${e.cost}`]
        if (e.durationMs) parts.push(`${e.durationMs}ms`)
        if (e.failure) parts.push(`FAILED:${e.failure}`)
        return parts.join(' ')
      }),
    }
  }
}
