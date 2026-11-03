/**
 * 自动研判开关的行为验收。
 *
 * 只测「开关逻辑」「注入内容」「实时开关」，不碰网络与模型。
 * 运行：node test/auto-plan.test.mjs
 */

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { shouldAutoPlan, renderHint, extractUserText, installAutoPlan } from '../lib/auto-plan.js'
import { resolveInitialEnabled, resolveStatePath, writePersistedEnabled, readPersistedEnabled } from '../lib/state.js'

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
// ── 状态优先级：状态文件 > 插件配置 > 内置默认 ──────────────────────────────
{
  // 内置默认应为开启（目标用户是小白，装完即用）。
  const fallback = resolveInitialEnabled(undefined)
  assert.equal(typeof fallback.enabled, 'boolean', '默认值必须是布尔')
  assert.equal(fallback.enabled, true, '内置默认应为开启')

  // 配置能覆盖默认。
  const fromConfig = resolveInitialEnabled({ autoPlan: { enabled: false } })
  assert.equal(fromConfig.enabled, false, '配置可以关掉')

  // 状态文件能覆盖配置（用户点过的选择优先）。
  //
  // 注意：这里会动到**真实**的状态文件，所以先记下原值、结束时原样还原。
  // 早先的版本直接写死 false，等于把用户的开关偷偷关掉了。
  const original = readPersistedEnabled()
  const wrote = writePersistedEnabled(true)
  const afterWrite = resolveInitialEnabled({ autoPlan: { enabled: false } })
  if (wrote) {
    assert.equal(afterWrite.enabled, true, '状态文件应覆盖配置')
    assert.equal(readPersistedEnabled(), true, '应能读回刚写入的值')
  } else {
    // 磁盘不可写时降级成内存，也不能抛错。
    assert.equal(afterWrite.enabled, true, '磁盘不可写时至少内存生效')
  }

  // 还原现场。
  if (original === null) {
    const file = resolveStatePath()
    if (file !== null) {
      try {
        rmSync(file, { force: true })
      } catch {
        /* 删不掉就算了，不影响断言 */
      }
    }
  } else {
    writePersistedEnabled(original)
    assert.equal(readPersistedEnabled(), original, '应还原成测试前的值')
  }
}

console.log('auto-plan 检查全部通过')