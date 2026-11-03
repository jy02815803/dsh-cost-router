/**
 * 自动研判开关 —— 把「先看看该不该拆」变成每条任务的默认动作。
 *
 * 设计要点（改动前务必先读）：
 *
 * 1. **研判是免费的**。这里只调用 `classify()` + `isHeterogeneous()`，都是纯规则
 *    正则与打分，不调模型、不花积分、微秒级返回。开关打开不会带来任何成本。
 *    真正花钱的是后续「拆开执行」，那是 `cost_router_run` 的事，与开关无关。
 *
 * 2. **我们只能给出强指令，不能硬接管执行**。`agent/pre-step` 这个钩子允许
 *    修改/拒绝即将发给模型的消息，但不允许插件替模型执行动作。所以这里是往
 *    消息尾部注入一条提示：「本轮先用 cost_router_plan 研判」。模型看到它会照做，
 *    但这是一条指令而非铁律。要绝对强制就得接管整个编排循环，那样又慢又脆，
 *    不值得。
 *
 * 3. **不拆的时候不打扰用户**。判定「不用拆」时注入的文本明确要求模型
 *    「不要说、不要提拆分」，直接单模型干活。用户看到的体验和平时完全一样。
 *
 * 4. **注入的消息带 source 标记**，便于识别和排查，也不会被误当成用户原话。
 *
 * @module dsh-cost-router/auto-plan
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { classify, isHeterogeneous } from './router.js'

/** source 标记：用于识别这条消息是本插件注入的。 */
const SOURCE = {
  kind: 'dsh-cost-router',
  form: 'auto-plan',
}

/**
 * 从一批消息里取出「用户本轮说的话」。
 *
 * 只认 role === 'user' 且不是本插件注入的文本块，避免把工具结果、
 * 系统提示或上一轮我们自己注入的提示词又算一遍。
 *
 * @param {ReadonlyArray<object>} messages - 本轮即将进入模型的消息。
 * @returns {string} 拼接后的用户文本，没有则返回空串。
 */
export function extractUserText(messages) {
  const parts = []
  for (const message of messages ?? []) {
    if (message?.role !== 'user') continue
    if (message?.source?.kind === SOURCE.kind) continue
    for (const block of message.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 判断本轮要不要提示模型先研判。
 *
 * 只有「像一条真实任务」时才提示：太短的寒暄、纯确认、空文本都跳过，
 * 免得每句「好的」都触发一次无意义研判。
 *
 * @param {string} text - 用户本轮的文本。
 * @param {object} policy - 路由策略（用于取开关等配置）。
 * @returns {{trigger: boolean, kinds: string[], reason: string}}
 */
export function shouldAutoPlan(text, policy) {
  // 钩子传来的 liveState 是扁平结构 { enabled, minChars }；policy.autoPlan 是配置态结构。
  // 两个来源都要认，否则界面/配置里改的 minChars 永远被忽略成默认 12。
  const minChars = policy?.minChars ?? policy?.autoPlan?.minChars ?? 12
  const trimmed = String(text ?? '').trim()

  if (trimmed.length === 0) {
    return { trigger: false, kinds: [], reason: '本轮没有用户文本' }
  }
  if (trimmed.length < minChars) {
    return { trigger: false, kinds: [], reason: `文本过短（${trimmed.length} < ${minChars} 字），不像任务` }
  }

  const kinds = classify(trimmed)
  const hetero = isHeterogeneous(trimmed, kinds)
  return {
    trigger: true,
    kinds,
    reason: hetero.yes
      ? `规则预判：建议拆分（${hetero.why}）`
      : `规则预判：不必拆分（${hetero.why}）`,
    willDecompose: hetero.yes,
  }
}

/**
 * 拼出注入给模型的提示文本。
 *
 * @param {object} verdict - shouldAutoPlan 的返回。
 * @returns {string} 提示文本。
 */
export function renderHint(verdict) {
  const kinds = verdict.kinds.length > 0 ? verdict.kinds.join('、') : '无明显特征'

  if (verdict.willDecompose) {
    return [
      '<cost-router-autoplan>',
      '本轮已开启「自动研判」开关，请在开始动手前先调用 `cost_router_plan`（参数 task = 用户原话）。',
      `规则预判：这个任务可能需要拆分（识别到能力：${kinds}）。`,
      '如果 plan 的结论是 mode="decomposed"，先把方案（拆几块、每块给哪个模型、预估花费）告诉用户，等用户确认再调 `cost_router_run`。',
      '如果 plan 的结论是 mode="single"，就直接按它推荐的那个模型把活干完，不要跟用户讨论拆分。',
      '</cost-router-autoplan>',
    ].join('\n')
  }

  return [
    '<cost-router-autoplan>',
    '本轮已开启「自动研判」开关，但规则预判这个任务**不需要拆分**，请直接开始干活。',
    `识别到能力：${kinds}。`,
    '**不要**调用 `cost_router_plan`，**不要**在回复里提「拆分」「路由」「成本」这些词，用户只想要结果。',
    '需要选模型时，挑能力够用的最便宜的那个即可。',
    '</cost-router-autoplan>',
  ].join('\n')
}

/**
 * 把提示挂到消息列表末尾。
 *
 * 追加而不是替换：用户原话保持完整，模型先看到任务再看提示。
 *
 * @param {ReadonlyArray<object>} messages - 原有消息。
 * @param {string} text - 提示文本。
 * @returns {object[]} 新数组。
 */
export function appendHint(messages, text) {
  const hint = createUserMessage({
    content: [{ type: 'text', text }],
    source: SOURCE,
  })
  return [...(messages ?? []), hint]
}

/**
 * 安装 pre-step 钩子。
 *
 * @param {object} ctx - Cordis context.
 * @param {object} liveState - 实时开关状态：{ enabled, minChars }。
 * @returns {void}
 */
export function installAutoPlan(ctx, liveState) {
  if (typeof ctx?.on !== 'function') return

  // 钩子**无条件挂上**，开关判断放在里面实时做。
  //
  // 这是免重启的关键：如果按启动时的开关值决定挂不挂钩子，用户在新界面上
  // 打开开关后就得重启才生效——点一下没反应，比没有开关更糟。挂在里面之后，
  // 每次任务都读一次 liveState，点开关立刻生效。
  //
  // 代价可忽略：关着时每次只多一次布尔判断，不调模型、不花钱。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()

    // 被拒绝、或没有消息时什么都不做。
    if (decision?.kind === 'reject') return decision
    const messages = decision?.messages
    if (!Array.isArray(messages) || messages.length === 0) return decision

    // 实时读开关：关着就放行，完全等同没有这个插件。
    if (liveState?.enabled !== true) return decision

    // 已经有本插件的提示就别重复注入（多步循环里 pre-step 会反复触发）。
    if (messages.some((m) => m?.source?.kind === SOURCE.kind)) return decision

    const text = extractUserText(messages)
    const verdict = shouldAutoPlan(text, liveState)
    if (!verdict.trigger) return decision

    return {
      ...decision,
      messages: appendHint(messages, renderHint(verdict)),
    }
  })
}
