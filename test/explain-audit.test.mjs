/**
 * 0.5.0 可解释性与隐私审计测试。
 *
 * 全部离线：桩模型、临时目录，不调用真实模型、不访问网络、不读写用户状态。
 * 运行：node test/explain-audit.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrivacyAudit } from '../lib/audit.js'
import { costDelta, priceSourceSummary } from '../lib/pricing.js'
import { decisionCard } from '../lib/explain.js'
import { Orchestrator } from '../lib/orchestrator.js'

/** 读审计文件为对象行；文件不存在时返回空数组。 */
function rowsOf(audit) {
  try {
    return readFileSync(audit.path, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/**
 * 造一个只返回固定文本的离线 llm。
 *
 * @param {object} [options] - options.
 * @param {string[]} [options.modalities] - 模型输入模态，默认只有 text。
 * @returns {{ctx: object, calls: Array<object>}} stub context and call log.
 */
function fakeCtx(options = {}) {
  const modalities = options.modalities ?? ['text']
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [{ id: 'paid', name: 'Paid', inputModalities: modalities }],
    resolveModelInfo: async (_p, id) => ({
      context: { contextWindow: 192000 },
      reasoning: { efforts: [{ id: 'high' }] },
      id,
    }),
    stream: (request) => {
      calls.push(request)
      const system = request.system || ''
      let text = 'ok'
      if (system.includes('任务规划器')) {
        text = JSON.stringify({
          subtasks: [
            { id: 't1', kind: 'vision', instruction: '看图', needs: '图', depends_on: [] },
            { id: 't2', kind: 'writing', instruction: '写稿', needs: 't1', depends_on: ['t1'] },
          ],
        })
      } else if (system.includes('合并成一份完整成果')) {
        text = '汇总稿'
      }
      return (async function* () {
        yield { type: 'text-delta', text }
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return {
    ctx: {
      get: (name) => {
        if (name === 'llm') return llm
        if (name === 'settings') return { describe: () => [] }
        return undefined
      },
    },
    calls,
  }
}

// 决策卡片只输出元数据，且能提示启发式价格。
{
  const card = decisionCard({
    kinds: ['vision', 'writing'],
    willDecompose: true,
    models: [
      { fromCatalog: true, free: true },
      { fromCatalog: false, free: true },
      { fromCatalog: false, free: false },
    ],
    estimated: 0.004,
  })
  assert.equal(card.decision, 'decompose')
  assert.equal(card.confidence, 'high')
  assert.equal(card.priceSources.declared, 1)
  assert.equal(card.priceSources.heuristic, 1)
  assert.equal(card.priceSources.unknown, 1)
  assert.ok(card.warnings.some((w) => w.includes('名称推断免费')))
  assert.equal(JSON.stringify(card).includes('任务正文'), false)
}

// 估实偏差要区分「完全吻合」「估算不可用」「误差较大」。
{
  assert.equal(costDelta(0, 0).quality, 'exact')
  assert.equal(costDelta(0, 0.2).quality, 'estimate-unavailable')
  assert.equal(costDelta(0.1, 0.11).quality, 'good')
  assert.equal(costDelta(0.1, 0.5).quality, 'poor')
  assert.deepEqual(priceSourceSummary([]), { declared: 0, heuristic: 0, unknown: 0 })
}

// 审计白名单：默认关闭、开启后只存约定字段、可删除。
{
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-cost-router-audit-'))
  const statePath = path.join(sandbox, 'state.json')
  try {
    const disabled = new PrivacyAudit({ statePath })
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.record({ stage: 'decision', task: '不应保存的任务正文' }), false)

    const audit = new PrivacyAudit({ enabled: true, statePath })
    assert.equal(audit.record({
      stage: 'decision',
      kinds: ['vision'],
      decision: 'decompose',
      model: 'p/m',
      estimated: 0.01,
      actual: 0.02,
      quality: 'fair',
      accepted: true,
      task: '这段任务正文绝不能落盘',
    }), true)
    const content = readFileSync(audit.path, 'utf8')
    assert.equal(content.includes('不应保存'), false)
    assert.equal(content.includes('这段任务正文'), false)
    const row = JSON.parse(content.trim())
    assert.deepEqual(Object.keys(row).sort(), [
      'accepted', 'actual', 'decision', 'estimated', 'kinds', 'model', 'quality', 'stage', 'ts',
    ].sort())
    assert.equal(audit.clear(), true)
    assert.equal(rowsOf(audit).length, 0)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// 开关必须是实时的：界面翻转 liveState 立即生效，不需要重启。
// 这是 0.5.0 修掉的「假开关」——以前开关在构造时固化，点开了也不写盘。
{
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-cost-router-live-'))
  const statePath = path.join(sandbox, 'state.json')
  try {
    const liveState = { auditEnabled: false }
    const audit = new PrivacyAudit({ liveState, statePath })
    assert.equal(audit.enabled, false)
    assert.equal(audit.record({ stage: 'decision' }), false, '关闭时不得写盘')

    liveState.auditEnabled = true
    assert.equal(audit.enabled, true, '翻转 liveState 后应立即生效')
    assert.equal(audit.record({ stage: 'outcome' }), true)
    assert.equal(rowsOf(audit).length, 1)

    liveState.auditEnabled = false
    assert.equal(audit.record({ stage: 'outcome' }), false, '关掉后不得继续写盘')
    assert.equal(rowsOf(audit).length, 1, '已有记录不应被回删')
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// 跨轮不得复用上一轮的估算：beginRun 必须把 lastEstimate 归零。
// 若不清零，新任务会拿上一个任务的金额去算偏差，用户看到的准确率是假的。
{
  const { ctx } = fakeCtx()
  const orch = new Orchestrator(ctx, {}, { explain: true })
  await orch.plan({ task: '帮我把这段会议纪要压缩成三条要点' })
  assert.ok(Number.isFinite(orch.lastEstimate) && orch.lastEstimate > 0, 'single 方案也要给出估算')
  orch.beginRun()
  assert.equal(orch.lastEstimate, null)
  assert.equal(orch.lastKinds, null)
  assert.equal(orch.lastDecision, null)
  assert.equal(orch.costReport().estimate.estimated, 0, '归零后不得残留上一轮的估算')
  orch.totalCost = 0.5
  assert.equal(orch.costReport().estimate.quality, 'estimate-unavailable', '无估算基线但有实耗时要如实标记，不能假装吻合')
}

// plan 与 run 各自只写一条审计；同一决策不得在审计文件里出现两次。
{
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-cost-router-run-'))
  const statePath = path.join(sandbox, 'state.json')
  try {
    const liveState = { auditEnabled: true }
    const audit = new PrivacyAudit({ liveState, statePath })
    const { ctx } = fakeCtx()
    const orch = new Orchestrator(ctx, {}, { audit, explain: true })
    const task = '帮我把这段会议纪要压缩成三条要点'

    const plan = await orch.plan({ task })
    assert.equal(plan.mode, 'single')
    assert.ok(Number(plan.estCost) > 0, 'plan 必须带回非零估算')
    assert.ok(plan.decision, 'plan 必须带回决策卡片')
    assert.deepEqual(rowsOf(audit).map((r) => r.stage), ['decision'])

    const run = await orch.run({ task })
    assert.equal(run.mode, 'single')
    assert.ok(run.decision, 'run 结果要能看出当初怎么决定的')
    const rows = rowsOf(audit)
    assert.deepEqual(rows.map((r) => r.stage), ['decision', 'outcome'], 'run 只补 outcome，不再重复 decision')
    const outcome = rows[1]
    assert.ok(outcome.estimated > 0, '单独调 run 也要有估算基线，不能恒为 0')
    assert.equal(outcome.model, 'p/paid')
    assert.equal(outcome.accepted, true)
    assert.ok(outcome.actual > 0)
    assert.equal(orch.costReport().estimate.quality, costDelta(outcome.estimated, outcome.actual).quality)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// 分解执行时，子任务失败要让审计如实记 accepted=false，不能报"整体达成"。
{
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-cost-router-dec-'))
  const statePath = path.join(sandbox, 'state.json')
  try {
    const audit = new PrivacyAudit({ liveState: { auditEnabled: true }, statePath })
    const { ctx } = fakeCtx({ modalities: ['text'] })
    const orch = new Orchestrator(ctx, {}, { audit, explain: true })
    const run = await orch.run({ task: '看这五张扫描件截图提取表格数据，再写一份分析报告' })
    assert.equal(run.mode, 'decomposed')
    const rows = rowsOf(audit)
    assert.deepEqual(rows.map((r) => r.stage), ['outcome'])
    assert.equal(rows[0].decision, 'decompose')
    assert.equal(rows[0].accepted, false, 'vision 子任务无可用模型，必须记为未达成')
    assert.ok(rows[0].estimated > 0)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// 确认过的方案在 run 阶段沿用 plan 的估算口径，偏差才有可比性。
{
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-cost-router-conf-'))
  const statePath = path.join(sandbox, 'state.json')
  try {
    const audit = new PrivacyAudit({ liveState: { auditEnabled: true }, statePath })
    const { ctx } = fakeCtx()
    const orch = new Orchestrator(ctx, {}, { audit, explain: true })
    const task = '帮我把这段会议纪要压缩成三条要点'
    const plan = await orch.plan({ task })
    await orch.run({ task, planId: plan.planId })
    const rows = rowsOf(audit)
    assert.deepEqual(rows.map((r) => r.stage), ['decision', 'outcome'])
    assert.equal(rows[1].estimated, plan.estCost, 'outcome 的预估应等于用户确认过的数字')
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// 审计关闭时，plan/run 全流程零写盘，且仍返回决策卡片。
{
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-cost-router-off-'))
  const statePath = path.join(sandbox, 'state.json')
  try {
    const audit = new PrivacyAudit({ liveState: { auditEnabled: false }, statePath })
    const { ctx } = fakeCtx()
    const orch = new Orchestrator(ctx, {}, { audit, explain: true })
    const task = '帮我把这段会议纪要压缩成三条要点'
    const plan = await orch.plan({ task })
    const run = await orch.run({ task })
    assert.ok(plan.decision && run.decision)
    assert.equal(rowsOf(audit).length, 0, '未开启审计时不得产生任何文件内容')
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

console.log('0.5.0 可解释与隐私审计测试通过')
