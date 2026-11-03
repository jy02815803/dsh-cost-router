/**
 * cost-router 冒烟测试。
 *
 * 不依赖 DSH 运行时：用桩替代 ctx.llm / ctx.tools / ctx.settings，
 * 验证路由策略、异构判定、多模态通道、失败隔离、汇总选型这几条真逻辑。
 *
 * 运行：node test/smoke.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classify, isHeterogeneous, pickModel, pickSynthesisModel, estimateCost } from '../lib/router.js'
import { collectCatalogsByProvider, collectCatalogEntries, readMultiplier, looksFree, modelMatches } from '../lib/catalog.js'
import { Orchestrator } from '../lib/orchestrator.js'
import { callModel } from '../lib/llm.js'

/** 造一个模型目录快照。 */
function model(overrides) {
  return {
    provider: 'p',
    model: 'm',
    name: 'M',
    supportsImage: false,
    inputModalities: [],
    contextWindow: 128000,
    maxTokens: 8192,
    reasoningEfforts: [],
    costMultiplier: 1,
    free: false,
    fromCatalog: false,
    ...overrides,
  }
}

/** 造一个目录快照。 */
function snapshot(models) {
  return { models, providers: [], takenAt: new Date().toISOString() }
}

// ── 分类与异构判定 ───────────────────────────────────────────────────────────

assert.deepEqual(classify('看这五张扫描件截图提取表格数据，再写一份分析报告'), ['vision', 'writing'])
assert.deepEqual(classify('帮我起草一份通知'), ['writing'])
assert.deepEqual(classify('写一个爬虫脚本'), ['code'])

assert.equal(isHeterogeneous('起草一份通知', ['writing']).yes, false)
assert.equal(isHeterogeneous('看图提取表格再写报告', ['vision', 'writing']).yes, true)
// 只有两类能力、但动作少 → 拆不划算（分解费 + 汇总费 > 收益）。
assert.equal(isHeterogeneous('读全文并分析原因', ['longdoc', 'reasoning']).yes, false)
// 动作够多 + 两类能力 → 拆划算。
assert.equal(isHeterogeneous('通读全文，提取数据，交叉分析，然后写成结论', ['longdoc', 'reasoning']).yes, true)

// ── 成本口径 ────────────────────────────────────────────────────────────────

assert.equal(readMultiplier({ creditMultiplier: 0 }), 0)
assert.equal(readMultiplier({ creditMultiplier: 0.29 }), 0.29)
assert.equal(readMultiplier(undefined), 1)
assert.equal(readMultiplier({ creditMultiplier: -1 }), 1, '负倍率不能当免费')
assert.equal(looksFree('OC · DeepSeek V4.1 Flash Free'), true)
assert.equal(looksFree('Hy3'), false)

// ── 目录抽取（settings 形状） ────────────────────────────────────────────────

const settingsValue = {
  regions: {
    cn: {
      lastCatalog: [
        { id: 'hy3', name: 'Hy3', creditMultiplier: 0, contextWindow: 192000, supportsImages: true },
        { id: 'space-bunny', name: 'Space-Bunny', creditMultiplier: 3.31, contextWindow: 200000 },
      ],
    },
  },
}
const entries = collectCatalogEntries(settingsValue)
assert.equal(entries.size, 2)
assert.equal(readMultiplier(entries.get('hy3')), 0)
assert.equal(entries.get('hy3').supportsImages, true)

const catalogs = collectCatalogsByProvider([{ ns: 'dsh-connect-workbuddy', value: settingsValue }])
assert.equal(catalogs.has('dsh-connect-workbuddy'), true)
assert.equal(catalogs.get('dsh-connect-workbuddy').size, 2)

// ── 路由：能力是门槛，成本是目标 ─────────────────────────────────────────────

const policy = {
  floors: { vision: 5, reasoning: 4, writing: 4, text: 3, code: 4, longdoc: 3, bulk: 3 },
  capabilityOverrides: {},
}

const catalog = snapshot([
  model({ model: 'free-flash', name: 'Flash Free', costMultiplier: 0, free: true }),
  model({ model: 'cheap', name: 'Cheap', costMultiplier: 0.3 }),
  model({ model: 'mid', name: 'Mid', costMultiplier: 1, reasoningEfforts: ['high'] }),
  model({ model: 'vl', name: 'VL', costMultiplier: 1, supportsImage: true, inputModalities: ['text', 'image'] }),
  model({ model: 'flagship', name: 'Flagship', costMultiplier: 3.31, contextWindow: 1000000, reasoningEfforts: ['high'] }),
])

// 文本任务：优先免费模型。
const textPick = pickModel('text', catalog, policy)
assert.equal(textPick.model, 'free-flash', '文本任务应选免费模型')

// 视觉任务：只有支持图片的模型能过门槛，且不能选免费的（免费模型不支持图）。
const visionPick = pickModel('vision', catalog, policy)
assert.equal(visionPick.model, 'vl', '视觉任务应选支持图片的模型')

// 强制强模型时忽略成本。
const strongPick = pickModel('reasoning', catalog, policy, { forceStrong: true })
assert.ok(['flagship', 'mid'].includes(strongPick.model), '强制强模型应落在 mid/flagship')

// 汇总模型：按能力而非成本选，不该选免费的那个。
const synthPick = pickSynthesisModel(catalog, policy)
assert.notEqual(synthPick.model, 'free-flash', '汇总不该选最便宜的那个')
assert.equal(synthPick.model, 'flagship', '汇总应选上下文最大的强模型')

// 显式指定模型时服从用户。
const pinned = pickModel('text', catalog, policy, { pin: 'Flagship' })
assert.equal(pinned.model, 'flagship')

// 模型匹配支持 id 与显示名。
assert.equal(modelMatches(model({ model: 'hy3', name: 'Hy3' }), 'hy3'), true)
assert.equal(modelMatches(model({ model: 'hy3', name: 'Hy3' }), 'Hy3'), true)
assert.equal(modelMatches(model({ model: 'hy3', name: 'Hy3' }), 'hy'), true)
assert.equal(modelMatches(model({ model: 'hy3', name: 'Hy3' }), 'zzz'), false)

// ── 成本估算 ────────────────────────────────────────────────────────────────

assert.equal(estimateCost(model({ costMultiplier: 0 }), 1000, 1000), 0, '免费模型成本为 0')
assert.ok(estimateCost(model({ costMultiplier: 1 }), 3000, 3000) > 0)

// ── 编排器：端到端（用桩 llm） ───────────────────────────────────────────────

/**
 * 造一个假的 ctx.llm：按 system 提示返回不同的内容。
 * @param {object} options - behavior options.
 * @returns {object} the fake ctx.
 */
function fakeCtx(options = {}) {
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'workbuddy', name: 'WorkBuddy' }],
    listModels: async () => (options.onlyExpensive
      ? [{ provider: 'workbuddy', id: 'hy3', name: 'Hy3', inputModalities: ['text', 'image'] }]
      : [
        { provider: 'workbuddy', id: 'hy3', name: 'Hy3', inputModalities: ['text', 'image'] },
        { provider: 'workbuddy', id: 'vl', name: 'VL Free', inputModalities: ['text', 'image'] },
      ]),
    resolveModelInfo: async (p, m) => ({
      provider: p, id: m, name: m,
      context: { contextWindow: 192000 },
      ...(options.reasoning ? { reasoning: { efforts: [{ id: 'high', name: 'High' }] } } : {}),
    }),
    stream: (request) => {
      calls.push(request)
      const system = request.system || ''
      const userText = (request.messages[0]?.content || [])
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
      let text
      if (options.decomposeFails) {
        text = 'not json'
      } else if (system.includes('任务规划器')) {
        text = JSON.stringify({
          subtasks: [
            { id: 't1', kind: 'vision', instruction: '提取表格数据', needs: '看图', depends_on: [] },
            { id: 't2', kind: 'writing', instruction: '写分析报告', needs: 't1产出', depends_on: ['t1'] },
          ],
        })
      } else if (system.includes('合并成一份完整成果')) {
        // 汇总模型看到失败标记时应当把它反映进结果，而不是假装成功。
        text = userText.includes('失败') ? '【汇总稿】注意：t1 失败' : '【汇总稿】最终。'
      } else if (system.includes('子任务类型：vision')) {
        if (options.visionFails) throw new Error('vision model exploded')
        text = '识别结果：X=1'
      } else {
        text = '分析结论：建议推进。'
      }
      const imageCount = (request.messages[0]?.content || []).filter((b) => b.type === 'image').length
      return (async function* () {
        yield { type: 'text-delta', text }
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        void imageCount
      })()
    },
  }
  return { ctx: { get: (name) => (name === 'llm' ? llm : undefined) }, llm, calls }
}

const { ctx: fake1, calls: calls1 } = fakeCtx()
const orch = new Orchestrator(fake1, policy)
const plan = await orch.plan({ task: '看这五张扫描件截图提取表格数据，再写一份分析报告' })
assert.equal(plan.mode, 'decomposed')
assert.equal(plan.subtasks.length, 2)
assert.equal(plan.subtasks[0].model.includes('workbuddy/'), true)

const run = await orch.run({ task: '看这五张扫描件截图提取表格数据，再写一份分析报告' })
assert.equal(run.mode, 'decomposed')
// 两个桩模型能力与窗口都相同 → 汇总选便宜的那个（vl 免费），
// 但汇总仍走独立的一次模型调用，所以输出是汇总稿而不是拼接。
assert.equal(run.output, '【汇总稿】最终。')
assert.ok(run.cost.calls >= 4, '至少 4 次调用（分解 + 2 子任务 + 汇总）')
// 桩目录里只有一个免费模型（VL Free）且能力相同 → 全程走免费 → 总成本 0。
// 这正是「免费优先」的核心断言。
assert.equal(run.cost.totalCost, 0, '能力相同时应全程走免费模型')
assert.ok(run.cost.byModel.every((m) => m.cost === 0), '每一笔调用都应记 0 成本')

// 对照：只有贵模型时成本必须大于 0（否则记账是假的）。
const { ctx: fakeExpensive } = fakeCtx({ onlyExpensive: true })
const orchExpensive = new Orchestrator(fakeExpensive, policy)
const runExpensive = await orchExpensive.run({ task: '看这五张扫描件截图提取表格数据，再写一份分析报告' })
assert.ok(runExpensive.cost.totalCost > 0, '只有贵模型时总成本应大于 0')

// 单一任务不拆。
const { ctx: fake2 } = fakeCtx()
const orch2 = new Orchestrator(fake2, policy)
const single = await orch2.run({ task: '把这段改成正式公文' })
assert.equal(single.mode, 'single')

// ── 编排器：失败隔离（一个子任务挂掉，另一个照跑，汇总仍产出） ───────────────

const { ctx: fake3 } = fakeCtx({ visionFails: true })
const orch3 = new Orchestrator(fake3, policy)
const run3 = await orch3.run({ task: '看这五张扫描件截图提取表格数据，再写一份分析报告' })
assert.equal(run3.mode, 'decomposed')
assert.ok(run3.output.length > 0, '子任务失败后汇总仍应产出内容')
assert.ok(run3.output.includes('失败'), '汇总应标明哪个子任务失败')
assert.ok(run3.output.includes('t1'), '汇总应指出失败的是哪个子任务')

// ── 编排器：图片只进视觉子任务 ──────────────────────────────────────────────

const { ctx: fake4, calls: calls4 } = fakeCtx()
const orch4 = new Orchestrator(fake4, policy)
await orch4.run({
  task: '看这五张扫描件截图提取表格数据，再写一份分析报告',
  images: [{ type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 100, width: 10, height: 10 } }],
})
const visionCall = calls4.find((c) => (c.system || '').includes('子任务类型：vision'))
const writingCall = calls4.find((c) => (c.system || '').includes('子任务类型：writing'))
assert.ok(visionCall, '应有视觉子任务调用')
assert.equal(visionCall.messages[0].content.filter((b) => b.type === 'image').length, 1, '视觉子任务应带图')
assert.equal(writingCall.messages[0].content.filter((b) => b.type === 'image').length, 0, '写作子任务不该带图')

// ── 编排器：预算熔断 ────────────────────────────────────────────────────────

const { ctx: fake5 } = fakeCtx()
const orch5 = new Orchestrator(fake5, policy)
await assert.rejects(
  () => orch5.run({ task: '看这五张扫描件截图提取表格数据，再写一份分析报告', budget: 0.0000001 }),
  /预算不足/,
  '预算不足应拒绝执行',
)

// ── 编排器：分解结果非法 JSON 时报错 ────────────────────────────────────────

const { ctx: fake6 } = fakeCtx({ decomposeFails: true })
const orch6 = new Orchestrator(fake6, policy)
await assert.rejects(
  () => orch6.run({ task: '看这五张扫描件截图提取表格数据，再写一份分析报告' }),
  /分解结果不是合法 JSON/,
)

// ── 路由：longdoc 必须按上下文窗口评分（曾经被错映射成 reasoning） ───────────

const longCatalog = snapshot([
  model({ model: 'tiny', name: 'Tiny', contextWindow: 8192, costMultiplier: 0.1 }),
  model({ model: 'mid128', name: 'Mid128', contextWindow: 128000, costMultiplier: 0.5 }),
  model({ model: 'big192', name: 'Big192', contextWindow: 192000, costMultiplier: 0.3 }),
])
const longPolicy = { floors: { longdoc: 4 }, capabilityOverrides: {} }

// longdoc 的评分读 contextWindow（≥200000→5、≥100000→4、否则 3）：big192 是 192000 → 4、mid128 → 4、tiny(8192) → 3。
// 门槛 4 之下候选是 big192/mid128，成本优先 → big192（0.3 比 0.5 便宜）。
assert.equal(
  pickModel('longdoc', longCatalog, longPolicy).model,
  'big192',
  'longdoc 应按上下文窗口评分并选窗口足够大的模型',
)
// 对照（钉死旧 bug）：longdoc 若被映射成 reasoning，三个模型都没有 reasoningEfforts
// → 全是 3 分，门槛 4 不达标 → 放宽后按成本升序 → 最便宜的 tiny。
// 这正是"长文档任务派给 8k 窗口小模型"的根因。
assert.notEqual(
  pickModel('longdoc', longCatalog, longPolicy).model,
  'tiny',
  '长文档任务绝不能因为窗口被无视而派给窗口极小的模型',
)

// ── 中止（abort）必须向上抛，不能被吞成"普通失败" ───────────────────────────

/** 造一个按指定方式中止/失败的 llm 桩。 */
function abortCtx(mode) {
  const abortError = () => {
    const error = new Error('用户点了停止')
    error.name = 'AbortError'
    return error
  }
  const llm = {
    stream: () => {
      if (mode === 'sync-throw') throw abortError()
      if (mode === 'code-only') {
        const error = new Error('中止')
        error.code = 'ABORT_ERR'
        throw error
      }
      if (mode === 'mid-stream') {
        return (async function* () {
          yield { type: 'text-delta', text: '半截输出' }
          throw abortError()
        })()
      }
      if (mode === 'finish-aborted') {
        return (async function* () {
          yield { type: 'text-delta', text: '半截输出' }
          yield { type: 'finish', reason: { kind: 'aborted' } }
        })()
      }
      // plain-error：普通故障，必须记成失败而不是中止。
      return (async function* () {
        throw new Error('模型炸了')
      })()
    },
  }
  return { get: (name) => (name === 'llm' ? llm : undefined) }
}

const abortModel = model({ provider: 'p', model: 'm', costMultiplier: 1 })

await assert.rejects(
  () => callModel(abortCtx('sync-throw'), abortModel, []),
  (error) => error?.name === 'AbortError',
  '流同步抛 AbortError 时应向上抛',
)
await assert.rejects(
  () => callModel(abortCtx('mid-stream'), abortModel, []),
  (error) => error?.name === 'AbortError',
  '流中途抛 AbortError 时应向上抛（不能带半截结果继续）',
)
await assert.rejects(
  () => callModel(abortCtx('finish-aborted'), abortModel, []),
  (error) => error?.name === 'AbortError',
  'finish.kind=aborted 也应归一成 AbortError 抛出去',
)
await assert.rejects(
  () => callModel(abortCtx('code-only'), abortModel, []),
  (error) => error?.name === 'AbortError',
  '只有 code=ABORT_ERR 没有 name 的异常也要认成中止',
)

// 对照：普通错误必须返回 failure，不能抛——否则一次模型故障会打断整批子任务。
const plainFail = await callModel(abortCtx('plain-error'), abortModel, [])
assert.equal(plainFail.text, '', '普通失败没有文本')
assert.ok(plainFail.failure !== null, '普通错误应记成 failure 而不是抛出')

// ── 编排器：跨 run 状态隔离 + 会话累计口径 ───────────────────────────────────

{
  // onlyExpensive：目录里只剩付费模型，保证确实会花钱。
  const { ctx: fakeIso } = fakeCtx({ onlyExpensive: true })
  const orchIso = new Orchestrator(fakeIso, policy)

  // 第一轮：预算极低。分解调用已经产生花费 → 随后预算检查拒绝。
  await assert.rejects(
    () => orchIso.run({ task: '看这五张扫描件截图提取表格数据，再写一份分析报告', budget: 0.0000001 }),
    /预算不足/,
    '低预算应拒绝执行',
  )
  const firstRunSpent = orchIso.totalCost
  assert.ok(firstRunSpent > 0, '第一轮失败前已经花掉分解费，这正是复现"预算串味"的前提')

  // 第二轮：不传预算。如果 budgetCap / totalCost 跨 run 残留，这里会再次报「预算不足」。
  const second = await orchIso.run({ task: '看这五张扫描件截图提取表格数据，再写一份分析报告' })
  assert.equal(second.mode, 'decomposed', '第二轮不带预算应能正常拆解')
  assert.ok(second.cost.totalCost > 0, '第二轮应记录自己的花费')

  // 本次口径：不能把第一轮的花费算进来。
  assert.equal(second.cost.scope, 'run', 'run 返回的成本应是"本次"口径')
  assert.equal(second.cost.totalCost, orchIso.totalCost, 'run 成本应等于本轮累计')

  // 会话口径：跨 run 累计，必须大于第二轮本身。
  const session = orchIso.summary({ scope: 'session' })
  assert.equal(session.scope, 'session', '显式要 session 口径')
  assert.ok(session.totalCost > second.cost.totalCost, '会话累计应大于单次运行成本')
  assert.ok(session.calls > second.cost.calls, '会话调用次数应大于单次运行次数')
  assert.equal(
    Number((session.totalCost - second.cost.totalCost).toFixed(6)),
    Number(firstRunSpent.toFixed(6)),
    '会话累计 - 第二轮 = 第一轮花掉的钱，两个口径必须能对上',
  )

  // 每笔账都带 runId，才能按次切分。
  assert.ok(orchIso.ledger.every((e) => typeof e.runId === 'number'), '每条账目都应带 runId')
  const runIds = new Set(orchIso.ledger.map((e) => e.runId))
  assert.equal(runIds.size, 2, '两轮运行应有两个不同的 runId')
}

// ── 插件的客户端依赖声明（页签能不能显示就靠它） ─────────────────────────────

{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const inject = pkg?.dsh?.client?.inject
  assert.ok(Array.isArray(inject), 'package.json 必须声明 dsh.client.inject 数组')

  // 根因：settings.plugins.tab 这个插槽由 ui-settings-plugins 声明。
  // 不把它列进 inject，该包不进客户端依赖图 → 页签静默消失（无报错、无日志）。
  assert.ok(
    inject.includes('@deepseek-ai/dsh-client-ui-settings-plugins'),
    'inject 必须包含 @deepseek-ai/dsh-client-ui-settings-plugins，否则设置页看不到「成本路由」页签',
  )
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-slots'), 'inject 必须包含 ui-slots（slots.inject 的前提）')
  assert.ok(inject.includes('@deepseek-ai/dsh-client-locale'), 'inject 必须包含 locale（文案注册的前提）')

  assert.equal(pkg.version, '0.4.0', '版本号应为 0.4.0')
}
console.log('全部通过：分类、异构判定、成本口径、目录抽取、路由策略、端到端编排、失败隔离、多模态通道、预算熔断、longdoc 评分、中止上抛、跨 run 隔离、客户端依赖声明')
