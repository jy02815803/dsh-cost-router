/**
 * 自动研判开关的行为验收。
 *
 * 只测「开关逻辑」「注入内容」「实时开关」，不碰网络与模型。
 * 运行：node test/auto-plan.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'

// auto-plan.js 静态依赖 DSH 的 createUserMessage；本测试只验证消息形状与开关
// 逻辑，不启动 DSH，因此用最小模块桩替代该依赖。状态测试另用独立 DSH_HOME，
// 绝不读写当前用户真实的 state.json。
const LLM_STUB_URL = 'data:text/javascript,export function createUserMessage(input)%7Breturn%7Brole%3A%22user%22%2C...input%7D%7D'
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') {
      return { url: LLM_STUB_URL, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const {
  shouldAutoPlan,
  renderHint,
  extractUserText,
  installAutoPlan,
} = await import('../lib/auto-plan.js')
const {
  readPersistedEnabled,
  readPersistedState,
  resolveInitialEnabled,
  resolveStatePath,
  writePersistedEnabled,
  writePersistedState,
} = await import('../lib/state.js')

const policy = { autoPlan: { enabled: true, minChars: 12 } }

/** 收集一个 ctx 上挂到的钩子。 */
function collectHooks() {
  const handlers = []
  return {
    handlers,
    ctx: { on: (event, fn) => handlers.push({ event, fn }) },
  }
}

// ── 文本抽取 ────────────────────────────────────────────────────────────────
{
  const messages = [
    { role: 'developer', content: [{ type: 'text', text: '系统提示' }] },
    { role: 'user', content: [{ type: 'text', text: '这是用户的话' }] },
    { role: 'assistant', content: [{ type: 'text', text: '模型的话' }] },
  ]
  assert.equal(extractUserText(messages), '这是用户的话', '只取 user 角色的文本')

  // 本插件自己注入的提示不能被当成用户输入，否则会自我循环。
  const withHint = [
    { role: 'user', content: [{ type: 'text', text: '真实任务内容在这里' }] },
    { role: 'user', content: [{ type: 'text', text: '注入的提示' }], source: { kind: 'dsh-cost-router', form: 'auto-plan' } },
  ]
  assert.equal(extractUserText(withHint), '真实任务内容在这里', '跳过本插件注入的消息')

  assert.equal(extractUserText([]), '', '空消息返回空串')
  assert.equal(extractUserText(undefined), '', 'undefined 不抛错')
}

// ── 短文本不触发 ────────────────────────────────────────────────────────────
{
  assert.equal(shouldAutoPlan('好的', policy).trigger, false, '「好的」不触发')
  assert.equal(shouldAutoPlan('', policy).trigger, false, '空文本不触发')
  assert.equal(shouldAutoPlan('   ', policy).trigger, false, '纯空格不触发')
  assert.equal(shouldAutoPlan('帮我看看这个文件里有什么', policy).trigger, true, '够长就触发')
}

// ── 规则预判：该拆 / 不该拆 ─────────────────────────────────────────────────
{
  const vision = shouldAutoPlan('看这五张扫描件提取表格数据，再写一份分析报告', policy)
  assert.equal(vision.trigger, true)
  assert.equal(vision.willDecompose, true, '视觉+文本应判为要拆')

  const simple = shouldAutoPlan('帮我起草一份放假通知,语气正式一点', policy)
  assert.equal(simple.trigger, true)
  assert.equal(simple.willDecompose, false, '单一写作任务不该拆')
  assert.equal(simple.decision, 'single')

  // 元问题 / 追问上轮执行：不是新任务，不能触发拆解提示或自动执行。
  const meta = shouldAutoPlan('这一轮判定要拆分，它都分别用的哪个模型', policy)
  assert.equal(meta.decision, 'meta')
  assert.equal(meta.willDecompose, false)
  assert.equal(meta.autoEligible, undefined)
  assert.match(meta.reason, /追问|复盘/)
}

// ── 元问题只记录、不注入 ────────────────────────────────────────────────────
{
  const { handlers, ctx } = collectHooks()
  installAutoPlan(ctx, { enabled: true, minChars: 12 })
  const hook = handlers[0].fn
  const messages = [{ role: 'user', content: [{ type: 'text', text: '上一轮用了哪个模型，为什么没有执行？' }] }]
  const out = await hook({}, async () => ({ kind: 'enter', messages }))
  assert.equal(out.messages.length, 1, '追问上轮执行时不应注入成本路由提示')
  const runtime = (await import('../lib/runtime.js')).getRuntime()
  assert.equal(runtime.lastVerdict?.decision, 'meta', '元问题要进入可见运行态')
  assert.equal(runtime.lastVerdict?.injected, false)
  assert.equal(runtime.lastVerdict?.autoEligible, false)
}

// ── 注入文本的语义 ──────────────────────────────────────────────────────────
{
  const yes = renderHint({ kinds: ['vision', 'writing'], willDecompose: true })
  assert.match(yes, /cost_router_plan/, '建议拆分时要让模型调 plan')
  assert.match(yes, /cost-router-autoplan/, '要有可识别的标记')

  const no = renderHint({ kinds: ['writing'], willDecompose: false })
  assert.match(no, /不要.*拆分|不需要拆分/, '不该拆时要明确禁止拆分')
  assert.match(no, /用户只想要结果/, '要求不打扰用户')
}

// ── 钩子安装：永远挂上，开关在内部实时判断 ──────────────────────────────────
{
  const a = collectHooks()
  installAutoPlan(a.ctx, { enabled: false, minChars: 12 })
  assert.equal(a.handlers.length, 1, '即使开关关着也要挂钩子，否则无法免重启打开')
  assert.equal(a.handlers[0].event, 'agent/pre-step', '挂在 pre-step 上')

  const b = collectHooks()
  installAutoPlan(b.ctx, { enabled: true, minChars: 12 })
  assert.equal(b.handlers.length, 1, '开关打开时同样只挂一个')

  // 没有 ctx.on（某些宿主环境）也不能抛错。
  installAutoPlan({}, { enabled: true, minChars: 12 })
}

// ── 实时开关：同一个钩子，改掉 liveState 立刻改变行为 ───────────────────────
{
  const { handlers, ctx } = collectHooks()
  const liveState = { enabled: false, minChars: 12 }
  installAutoPlan(ctx, liveState)
  const hook = handlers[0].fn

  const task = [{ role: 'user', content: [{ type: 'text', text: '看这几张图提取表格再写报告给我' }] }]

  // 关着：原样放行，等同没有这个插件。
  const off = await hook({}, async () => ({ kind: 'enter', messages: task }))
  assert.equal(off.messages.length, 1, '关着时不注入')

  // 打开同一个 liveState 对象（模拟界面点击），无需重新安装钩子。
  liveState.enabled = true
  const on = await hook({}, async () => ({ kind: 'enter', messages: task }))
  assert.equal(on.messages.length, 2, '打开后立刻开始注入，无需重启')
  assert.equal(on.messages[1].source.kind, 'dsh-cost-router', '注入消息带 source 标记')

  // 再关掉，行为同样立刻恢复。
  liveState.enabled = false
  const offAgain = await hook({}, async () => ({ kind: 'enter', messages: task }))
  assert.equal(offAgain.messages.length, 1, '关掉后立刻停止注入')
}

// ── 注入去重与边界 ──────────────────────────────────────────────────────────
{
  const { handlers, ctx } = collectHooks()
  installAutoPlan(ctx, { enabled: true, minChars: 12 })
  const hook = handlers[0].fn

  const task = [{ role: 'user', content: [{ type: 'text', text: '看这几张图提取表格再写报告给我' }] }]
  const out = await hook({}, async () => ({ kind: 'enter', messages: task }))

  // 多步循环里不能重复注入。
  const again = await hook({}, async () => ({ kind: 'enter', messages: out.messages }))
  assert.equal(again.messages.length, 2, '已有提示时不再追加')

  // 拒绝的分支原样返回。
  const rejected = await hook({}, async () => ({ kind: 'reject' }))
  assert.equal(rejected.kind, 'reject', 'reject 原样透传')

  // 短消息不注入。
  const short = await hook({}, async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '好' }] }] }))
  assert.equal(short.messages.length, 1, '短消息不注入提示')

  // 没有消息也不能崩。
  const empty = await hook({}, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(empty.messages.length, 0, '空消息原样透传')
}

// ── minChars 的两种配置来源（扁平 liveState 与嵌套 policy） ─────────────────
{
  const longText = '看这五张扫描件截图提取表格数据，再写一份分析报告'
  assert.ok(longText.length >= 20, '样本文本要足够长，后面的阈值断言才有意义')

  // 扁平结构来自界面实时状态（{ enabled, minChars }）。
  const flat = shouldAutoPlan(longText, { enabled: true, minChars: 30 })
  assert.equal(flat.trigger, false, '扁平 minChars 抬到 30 后应判定为过短')
  assert.match(flat.reason, /文本过短/, '过短的判定理由要说清楚')

  // 嵌套结构来自配置文件（policy.autoPlan.minChars）。
  const nested = shouldAutoPlan(longText, { autoPlan: { minChars: 30 } })
  assert.equal(nested.trigger, false, 'policy.autoPlan.minChars 同样要生效')

  // 历史 bug：只读 policy.autoPlan.minChars，界面改的扁平值被忽略成默认 12。
  const interfaceWins = shouldAutoPlan(longText, { minChars: 30, autoPlan: { minChars: 999 } })
  assert.equal(interfaceWins.trigger, false, '扁平（实时）值优先于嵌套配置值')

  // 阈值调低到 1 时，连「好的」也算触发——证明闸门确实由 minChars 控制。
  const permissive = shouldAutoPlan('好的', { enabled: true, minChars: 1 })
  assert.equal(permissive.trigger, true, 'minChars 调到 1 后短句也触发')

  // 两个来源都不给时回落到内置默认 12。
  assert.equal(shouldAutoPlan('帮我写个通知', {}).trigger, false, '默认阈值 12 字，6 字短句不触发')
  assert.equal(shouldAutoPlan('帮我起草一份正式的放假通知', {}).trigger, true, '超过默认阈值就触发')
}
// ── 状态优先级与磁盘格式：全程在独立临时目录中运行 ───────────────────────────
{
  const originalDshHome = process.env.DSH_HOME
  const originalUserProfile = process.env.USERPROFILE
  const originalHome = process.env.HOME
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-cost-router-state-'))
  const goodRoot = path.join(sandbox, 'good-profile')
  const badRoot = path.join(sandbox, 'bad-home')
  const stateDir = path.join(goodRoot, '.dsh', 'dsh-cost-router')
  const stateFile = path.join(stateDir, 'state.json')

  const restoreEnv = (name, value) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  try {
    // 用一个普通文件占住 bad-home/dsh-cost-router，使 mkdirSync 必然失败，
    // 以此验证“候选目录不可写时切换到下一个”，不依赖 Windows ACL。
    mkdirSync(badRoot, { recursive: true })
    writeFileSync(path.join(badRoot, 'dsh-cost-router'), 'not-a-directory')
    mkdirSync(stateDir, { recursive: true })

    process.env.DSH_HOME = badRoot
    process.env.USERPROFILE = goodRoot
    delete process.env.HOME

    // 文件不存在：配置优先于内置默认。
    const absentDefault = resolveInitialEnabled(undefined)
    assert.deepEqual(
      { enabled: absentDefault.enabled, minChars: absentDefault.minChars, source: absentDefault.source },
      { enabled: true, minChars: 12, source: 'default' },
      '无状态文件且无配置时应使用内置默认',
    )
    const absentConfig = resolveInitialEnabled({ autoPlan: { enabled: false, minChars: 30 } })
    assert.deepEqual(
      { enabled: absentConfig.enabled, minChars: absentConfig.minChars, source: absentConfig.source },
      { enabled: false, minChars: 30, source: 'config' },
      '无状态文件时应采用插件配置',
    )

    // 兼容 0.4.0 的旧格式：只有 autoPlanEnabled，不应丢失开关值。
    writeFileSync(stateFile, JSON.stringify({ autoPlanEnabled: false }))
    assert.deepEqual(readPersistedState(), { enabled: false }, '应兼容旧格式 autoPlanEnabled')
    const oldFormat = resolveInitialEnabled({ autoPlan: { enabled: true, minChars: 30 } })
    assert.equal(oldFormat.enabled, false, '旧格式状态应覆盖配置里的 enabled')
    assert.equal(oldFormat.minChars, 30, '旧格式缺少 minChars 时应从配置补齐')
    assert.equal(oldFormat.source, 'file', '旧格式状态来源应标记为 file')

    // 新格式同时保存开关与阈值。
    writeFileSync(stateFile, JSON.stringify({ autoPlanEnabled: true, autoPlanMinChars: 20 }))
    const newFormat = resolveInitialEnabled({ autoPlan: { enabled: false, minChars: 30 } })
    assert.deepEqual(
      { enabled: newFormat.enabled, minChars: newFormat.minChars, source: newFormat.source },
      { enabled: true, minChars: 20, source: 'file' },
      '新格式状态应同时覆盖 enabled 与 minChars',
    )

    // 损坏 JSON、非对象和非法阈值都应安全降级，不能抛错。
    writeFileSync(stateFile, '{not json')
    assert.deepEqual(readPersistedState(), {}, '损坏 JSON 应视为无持久化状态')
    writeFileSync(stateFile, '[]')
    assert.deepEqual(readPersistedState(), {}, '数组不是合法状态对象')
    writeFileSync(stateFile, JSON.stringify({ autoPlanEnabled: 'yes', autoPlanMinChars: 0 }))
    assert.deepEqual(readPersistedState(), {}, '非法字段类型应被丢弃')
    const invalidFallback = resolveInitialEnabled({ autoPlan: { enabled: false, minChars: 7.9 } })
    assert.deepEqual(
      { enabled: invalidFallback.enabled, minChars: invalidFallback.minChars, source: invalidFallback.source },
      { enabled: false, minChars: 7, source: 'config' },
      '非法状态应回退到配置，合法小数阈值应归一成整数',
    )

    // 只写 enabled 时必须保留已有 minChars；写入后应能重新读取。
    writeFileSync(stateFile, JSON.stringify({ autoPlanEnabled: true, autoPlanMinChars: 18 }))
    assert.equal(writePersistedEnabled(false), true, '可写目录中的状态应成功落盘')
    assert.deepEqual(
      readPersistedState(),
      { enabled: false, minChars: 18 },
      'writePersistedEnabled 不应抹掉已有阈值',
    )
    assert.equal(readPersistedEnabled(), false, '旧读取 API 应继续可用')

    // 完整写入与原子替换后，状态文件应保持新格式。
    assert.equal(writePersistedState({ enabled: true, minChars: 9.7 }), true)
    assert.deepEqual(
      JSON.parse(readFileSync(stateFile, 'utf8')),
      { autoPlanEnabled: true, autoPlanMinChars: 9 },
      '新格式应落盘且阈值取整',
    )
    assert.equal(
      readdirSync(stateDir).some((name) => name.includes('.tmp')),
      false,
      '成功写入后不应残留临时文件',
    )

    // DSH_HOME 不可写时切换到 USERPROFILE/.dsh，并保证不留下探测文件。
    process.env.DSH_HOME = badRoot
    const fallbackPath = resolveStatePath()
    assert.equal(fallbackPath, stateFile, '不可写的 DSH_HOME 应切换到下一个候选目录')
    assert.equal(
      readdirSync(stateDir).some((name) => name.startsWith('.state-write-probe-')),
      false,
      '可写探测不能残留 probe 文件',
    )

    // 切回不可写目录后，写盘失败应降级为内存状态且不抛错；随后成功写盘
    // 会清掉内存兜底，磁盘重新成为唯一来源。
    process.env.DSH_HOME = badRoot
    process.env.USERPROFILE = path.join(sandbox, 'also-unwritable')
    mkdirSync(process.env.USERPROFILE, { recursive: true })
    mkdirSync(path.join(process.env.USERPROFILE, '.dsh'), { recursive: true })
    writeFileSync(path.join(process.env.USERPROFILE, '.dsh', 'dsh-cost-router'), 'not-a-directory')
    assert.equal(writePersistedState({ enabled: false, minChars: 24 }), false, '全部目录不可写时应只保留内存状态')
    const memoryFallback = resolveInitialEnabled({ autoPlan: { enabled: true, minChars: 12 } })
    assert.deepEqual(
      { enabled: memoryFallback.enabled, minChars: memoryFallback.minChars, source: memoryFallback.source },
      { enabled: false, minChars: 24, source: 'memory' },
      '写盘失败时应在当前进程内即时生效',
    )

    process.env.DSH_HOME = badRoot
    process.env.USERPROFILE = goodRoot
    assert.equal(writePersistedState({ enabled: true, minChars: 12 }), true, '恢复可写目录后应能落盘')
    const afterRecovery = resolveInitialEnabled({ autoPlan: { enabled: false, minChars: 30 } })
    assert.deepEqual(
      { enabled: afterRecovery.enabled, minChars: afterRecovery.minChars, source: afterRecovery.source },
      { enabled: true, minChars: 12, source: 'file' },
      '成功写盘后应清除内存兜底并由文件提供状态',
    )
  } finally {
    restoreEnv('DSH_HOME', originalDshHome)
    restoreEnv('USERPROFILE', originalUserProfile)
    restoreEnv('HOME', originalHome)
    try {
      rmSync(sandbox, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不改变已完成的断言。
    }
  }
}

console.log('auto-plan 检查全部通过')
