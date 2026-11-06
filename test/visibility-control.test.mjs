/**
 * 0.7.0 显性化、控制路由与质量档回归。
 *
 * 纯离线：不调用模型、不访问网络、不读写用户状态。
 * 运行：node test/visibility-control.test.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyTurn, pickModel } from '../lib/router.js'
import { planCard, renderPlanText } from '../lib/presentation.js'
import { getRuntime } from '../lib/runtime.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 元问题/追问：识别出来，且不得进入自动执行候选。
{
  assert.equal(classifyTurn('这一轮判定要拆分，它都分别用的哪个模型').meta, true)
  assert.equal(classifyTurn('Which model did it use in the previous round and why did it not run').meta, true)
  assert.equal(classifyTurn('帮我分析这张截图里的表格再写一份报告').meta, false)
  assert.equal(classifyTurn('Read the entire document, extract data, analyze why it changed, and write conclusions').meta, false)
}

// 方案卡片：人能读，且不含任务正文、指令或凭据。
{
  const plan = {
    planId: 'plan_test',
    mode: 'decomposed',
    reason: '识别到多类能力',
    detectedKinds: ['vision', 'writing'],
    subtasks: [
      { id: 't1', kind: 'vision', model: 'p/vl', free: true, costMultiplier: 0, depends_on: '-', instruction: '超级机密任务正文' },
      { id: 't2', kind: 'writing', model: 'p/writer', free: false, costMultiplier: 1, depends_on: 't1', instruction: '另一段机密正文' },
    ],
    synthesisModel: 'p/writer',
    estCost: 0.0042,
    fullSubtasks: [],
  }
  const card = planCard(plan, { qualityMode: 'quality-first' })
  assert.equal(card.planId, 'plan_test')
  assert.equal(card.qualityMode, 'quality-first')
  assert.equal(card.assignments.length, 2)
  assert.equal(card.hasTaskText, false)
  assert.equal(JSON.stringify(card).includes('超级机密任务正文'), false)
  assert.equal(JSON.stringify(card).includes('另一段机密正文'), false)
  assert.match(renderPlanText({ ...plan, card }), /成本路由方案/)
}

// 质量优先：能力达标后先选能力强/上下文大的模型，而不是最低倍率。
{
  const models = [
    { provider: 'p', model: 'cheap', name: 'Cheap', costMultiplier: 0, contextWindow: 8000, reasoningEfforts: [], supportsImage: false, inputModalities: [] },
    { provider: 'p', model: 'strong', name: 'Strong', costMultiplier: 3, contextWindow: 200000, reasoningEfforts: ['high'], supportsImage: false, inputModalities: [] },
  ]
  const catalog = { models }
  const policy = { floors: { reasoning: 4 }, qualityMode: 'quality-first', capabilityOverrides: {} }
  assert.equal(pickModel('reasoning', catalog, policy).model, 'strong')
  policy.qualityMode = 'balanced'
  assert.equal(pickModel('reasoning', catalog, policy).model, 'strong', '便宜模型能力不够时不能因 balanced 降级')

  const qualified = [
    ...models,
    { provider: 'p', model: 'cheap-qualified', name: 'Cheap Qualified', costMultiplier: 0, contextWindow: 128000, reasoningEfforts: ['high'], supportsImage: false, inputModalities: [] },
  ]
  policy.qualityMode = 'balanced'
  assert.equal(pickModel('reasoning', { models: qualified }, policy).model, 'cheap-qualified')
  policy.qualityMode = 'quality-first'
  assert.equal(pickModel('reasoning', { models: qualified }, policy).model, 'strong')
}

// 评测集与文档契约：元问题样本、手动模式、控制路由与胶囊插槽都在。
{
  const evaluation = JSON.parse(readFileSync(path.join(root, 'config', 'auto-plan-eval.json'), 'utf8'))
  assert.equal(evaluation.cases.length, 20)
  assert.ok(evaluation.cases.filter((c) => c.expectDecision === 'meta').length >= 4)

  const client = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
  assert.match(client, /conversation\.input\.right/)
  assert.match(client, /CONTROL_ROUTE/)
  assert.match(client, /confirm: true/)
  const control = readFileSync(path.join(root, 'lib', 'control.js'), 'utf8')
  assert.match(control, /confirmation-required/)
  assert.match(control, /executionMode: 'manual'/)
  assert.match(control, /autoExecute: false/)

  const runtime = getRuntime()
  assert.equal(runtime.lastPlanCard, null)
  assert.equal(runtime.lastVerdict, null)
}

console.log('0.7.0 显性化与控制路由回归测试通过')