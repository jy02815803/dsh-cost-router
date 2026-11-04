/**
 * 0.4.2 可信契约回归测试。
 *
 * 全部使用离线桩，不调用真实模型、不访问网络、不读写用户状态。
 * 运行：node test/trust-contract.test.mjs
 */

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
const LLM_STUB_URL =
  'data:text/javascript,export function createUserMessage(input)%7Breturn%7Brole%3A%22user%22%2C...input%7D%7D'
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: LLM_STUB_URL, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const { PlanStore } = await import('../lib/plan-store.js')
const { Orchestrator } = await import('../lib/orchestrator.js')
const {
  extractCurrentTurnUserText,
  installAutoPlan,
} = await import('../lib/auto-plan.js')

const policy = {
  floors: { vision: 5, reasoning: 4, writing: 4, text: 3, code: 4, longdoc: 3, bulk: 3 },
  capabilityOverrides: {},
}

/** 造一个可控的目录与模型调用桩。 */
function fakeCtx(options = {}) {
  const calls = []
  const takenAt = options.takenAt ?? '2026-01-01T00:00:00.000Z'
  const llm = {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [
      { id: 'free', name: 'Free', inputModalities: ['text', 'image'] },
      { id: 'paid', name: 'Paid', inputModalities: ['text', 'image'] },
    ],
    resolveModelInfo: async (_p, id) => ({
      context: { contextWindow: 192000 },
      reasoning: { efforts: [{ id: 'high' }] },
      id,
    }),
    stream: (request) => {
      calls.push(request)
      const system = request.system || ''
      let text
      if (system.includes('任务规划器')) {
        text = JSON.stringify({
          subtasks: [
            { id: 't1', kind: 'vision', instruction: '看图', needs: '图', depends_on: [] },
            { id: 't2', kind: 'writing', instruction: '写稿', needs: 't1', depends_on: ['t1'] },
          ],
        })
      } else if (system.includes('合并成一份完整成果')) {
        text = '汇总稿'
      } else {
        text = '子任务结果'
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
        if (name === 'settings') return { describe: () => options.descriptors ?? [] }
        return undefined
      },
    },
    calls,
    takenAt,
  }
}

const complexTask = '看这五张扫描件截图提取表格数据，再写一份分析报告'

// planId：用户确认的方案必须原样执行，且不再重新付分解费。
{
  const { ctx, calls } = fakeCtx()
  const orch = new Orchestrator(ctx, policy)
  const plan = await orch.plan({ task: complexTask })
  assert.equal(plan.mode, 'decomposed')
  assert.ok(typeof plan.planId === 'string' && plan.planId.startsWith('plan_'))
  const decomposeCallsAfterPlan = calls.filter((c) => (c.system || '').includes('任务规划器')).length
  assert.equal(decomposeCallsAfterPlan, 1)

  const run = await orch.run({ task: complexTask, planId: plan.planId })
  assert.equal(run.mode, 'decomposed')
  assert.equal(run.planId, plan.planId)
  assert.equal(calls.filter((c) => (c.system || '').includes('任务规划器')).length, 1, 'run 用 planId 时不能再次分解')
  await assert.rejects(
    () => orch.run({ task: complexTask, planId: plan.planId }),
    /方案不存在或已过期/,
    'planId 应是一次性的，防止重复执行',
  )
}

// 方案与调用参数不一致时明确拒绝，不静默重新拆解。
{
  const { ctx } = fakeCtx()
  const orch = new Orchestrator(ctx, policy)
  const plan = await orch.plan({ task: complexTask })
  await assert.rejects(
    () => orch.run({ task: complexTask + '，顺便翻译', planId: plan.planId }),
    /任务内容.*不一致/,
  )

  const plan2 = await orch.plan({ task: complexTask })
  const guarded = new Orchestrator(ctx, policy, { planStore: orch.planStore, freeOnly: true })
  await assert.rejects(
    () => guarded.run({ task: complexTask, planId: plan2.planId }),
    /成本护栏.*不一致/,
  )
}

// 同一 planId 可以在不同 Orchestrator 实例间消费（四个工具各自会新建实例），
// 并原样沿用方案保存时的目录快照，不因刷新时间不同而拒绝执行。
{
  const { ctx } = fakeCtx({ takenAt: '2026-01-01T00:00:00.000Z' })
  const orch = new Orchestrator(ctx, policy)
  const plan = await orch.plan({ task: complexTask })
  const changed = new Orchestrator(fakeCtx({ takenAt: '2026-01-01T00:00:01.000Z' }).ctx, policy, {
    planStore: orch.planStore,
  })
  const run = await changed.run({ task: complexTask, planId: plan.planId })
  assert.equal(run.mode, 'decomposed', '共享 planStore 后不同工具实例可执行同一确认方案')
}

// PlanStore 能检出篡改并限制数量。
{
  let counter = 0
  const store = new PlanStore({ limit: 2, idFactory: () => String(++counter) })
  const base = { task: 'a', mode: 'single', catalog: { models: [], takenAt: 'x' }, plan: { kind: 'text' } }
  const id1 = store.save(base)
  store.save({ ...base, task: 'b' })
  store.save({ ...base, task: 'c' })
  assert.equal(store.size, 2, '超过上限时淘汰最旧方案')
  await assert.rejects(() => Promise.resolve().then(() => store.consume(id1, { task: 'a' })), /不存在或已过期/)
}

// freeOnly 必须让所有调用都落在倍率 0 的模型上。
{
  const descriptors = [{
    ns: 'p',
    value: {
      catalog: [
        { id: 'free', name: 'Free', creditMultiplier: 0, contextWindow: 192000 },
        { id: 'paid', name: 'Paid', creditMultiplier: 3.31, contextWindow: 192000 },
      ],
    },
  }]
  const { ctx, calls } = fakeCtx({ descriptors })
  const orch = new Orchestrator(ctx, policy, { freeOnly: true })
  const run = await orch.run({ task: complexTask })
  assert.equal(run.mode, 'decomposed')
  assert.ok(calls.length > 0)
  assert.ok(calls.every((c) => c.model === 'free'), '仅免费模式不能调用收费模型')
  assert.equal(run.cost.totalCost, 0)
}

// 逐步预算：分解成功后，极低预算仍需在第一次子任务调用前停下。
{
  const { ctx, calls } = fakeCtx()
  const orch = new Orchestrator(ctx, policy)
  await assert.rejects(
    () => orch.run({ task: complexTask, budget: 0.0000001 }),
    /预算不足/,
  )
  assert.equal(calls.filter((c) => (c.system || '').includes('子任务类型')).length, 0, '预算不足时不能启动子任务')
}

// 自动研判：只看当前轮，上一轮的注入提示不能让后续新任务永久失效。
{
  assert.equal(
    extractCurrentTurnUserText([
      { role: 'user', content: [{ type: 'text', text: '上一轮长任务：看这五张扫描件提取表格再写报告' }] },
      { role: 'user', content: [{ type: 'text', text: '旧提示' }], source: { kind: 'dsh-cost-router' } },
      { role: 'assistant', content: [{ type: 'text', text: '已完成' }] },
      { role: 'user', content: [{ type: 'text', text: '看这几张图提取表格再写报告给我' }] },
    ]),
    '看这几张图提取表格再写报告给我',
  )

  const handlers = []
  const ctx = { on: (event, fn) => handlers.push({ event, fn }) }
  const liveState = { enabled: true, minChars: 12 }
  installAutoPlan(ctx, liveState)
  const hook = handlers[0].fn
  const first = await hook({}, async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: '看这几张图提取表格再写报告给我' }] }],
  }))
  assert.equal(first.messages.length, 2)

  const second = await hook({}, async () => ({
    kind: 'enter',
    messages: [
      ...first.messages,
      { role: 'assistant', content: [{ type: 'text', text: '结果' }] },
      { role: 'user', content: [{ type: 'text', text: '再把这些图里的数字整理成正式报告' }] },
    ],
  }))
  assert.equal(
    second.messages.filter((m) => m?.source?.kind === 'dsh-cost-router').length,
    2,
    '新的一轮应再次注入，不被历史提示永久去重',
  )
}

// dryRun 只给建议，不改消息。
{
  const handlers = []
  installAutoPlan({ on: (_event, fn) => handlers.push(fn) }, { enabled: true, minChars: 1, dryRun: true })
  const hook = handlers[0]
  const original = [{ role: 'user', content: [{ type: 'text', text: '看这五张图并写报告' }] }]
  const out = await hook({}, async () => ({ kind: 'enter', messages: original }))
  assert.equal(out.messages.length, 1, 'dryRun 不应注入提示')
}

console.log('0.4.2 可信契约测试通过')
