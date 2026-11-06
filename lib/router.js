/**
 * cost-router — 路由策略。
 *
 * 这一层回答两个问题：
 *   1. 这个任务该不该拆？（异构判定）
 *   2. 拆出来的每个子任务派给哪个模型？（能力匹配 × 成本优先）
 *
 * 路由的核心主张：**能力是门槛，成本是目标**。
 *  - 能力不够的模型一律不选（宁可慢、宁可贵，也不能让弱模型干强模型的活）
 *  - 能力够的模型里，优先选**免费**的，其次选便宜的
 *  - 视觉任务的能力门槛不可降（README 第四节：4 分和 5 分准确率差一个量级）
 *
 * @module dsh-cost-router/router
 */

import { CAPABILITIES, modelMatches } from './catalog.js'
import { ACTION_SIGNALS, META_SIGNALS, RULESETS, STRONG_SIGNALS } from './rules.js'

/** 任务类型 → 所需能力维度。与子任务 kind 一一对应。 */
export const KIND_TO_CAPABILITY = {
  vision: 'vision',
  longdoc: 'longdoc',
  reasoning: 'reasoning',
  code: 'coding',
  writing: 'writing',
  text: 'writing',
  bulk: 'bulk',
}

/**
 * 语种启发式：大段拉丁字母 + 常见英文词视为英文，否则用中文规则。
 * 这个判断只影响关键词规则，不改写任务正文，也不需要外部语言检测库。
 *
 * @param {string} text - task text.
 * @returns {'zh'|'en'} ruleset language.
 */
function detectLanguage(text) {
  const latin = (text.match(/[A-Za-z]/g) || []).length
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length
  if (cjk > 0) return 'zh'
  return latin >= 4 ? 'en' : 'zh'
}

/** 取得适用规则；中英文分别维护，见 lib/rules.js。 */
function rulesFor(text) {
  const language = detectLanguage(text)
  return {
    language,
    kinds: RULESETS[language],
    strong: STRONG_SIGNALS[language],
    actions: ACTION_SIGNALS[language],
    meta: META_SIGNALS[language],
  }
}

/**
 * 识别「追问上轮执行 / 元问题 / 指代前文」的句子。
 *
 * 这类话不是新任务，不该因为出现「模型 / 拆分 / 执行」等词就被建议拆解；
 * 它们也永远不该进入未来的自动执行路径。
 *
 * @param {string} text - current-turn user text.
 * @returns {{meta: boolean, language: 'zh'|'en', reason: string}}
 */
export function classifyTurn(text) {
  const source = String(text || '')
  const rules = rulesFor(source)
  const meta = rules.meta.test(source)
  return {
    meta,
    language: rules.language,
    reason: meta ? '本轮是在追问或复盘上一步，不是新任务' : '',
  }
}

/**
 * 判断任务文本命中了哪些能力类型。
 *
 * @param {string} text - task description.
 * @returns {string[]} matched kinds, in rule order.
 */
export function classify(text) {
  const source = String(text || '')
  const hits = []
  for (const rule of rulesFor(source).kinds) {
    if (rule.re.test(source) && !hits.includes(rule.kind)) hits.push(rule.kind)
  }
  return hits
}

/**
 * 判断任务是否值得拆解。
 *
 * 拆解不是免费的：付分解费、付汇总费、还有文风断裂的风险。只有任务
 * **同时包含多种能力**时才划算——同质任务拆开纯亏。
 *
 * @param {string} task - task description.
 * @param {string[]} kinds - detected kinds.
 * @returns {{yes: boolean, why: string}} the verdict and its reason.
 */
export function isHeterogeneous(task, kinds) {
  const text = String(task || '')
  const actions = (text.match(rulesFor(text).actions) || []).length
  const distinct = new Set(kinds).size

  // 视觉 + 文本是最典型的异构：便宜模型看不见图，旗舰模型干文本太贵。
  if (kinds.includes('vision') && kinds.length >= 2) {
    return { yes: true, why: '同时涉及视觉和文本，必须分派给不同模型' }
  }
  if (distinct >= 3) {
    return { yes: true, why: `涉及 ${distinct} 类不同能力（${kinds.join('、')}），单一模型很难都做好` }
  }
  // 「长文 + 推理」只有在任务还有多个动作时才值得拆；一句「读全文并分析原因」
  // 仍是同质任务，拆开只会多付分解费和汇总费。
  if (actions >= 3 && distinct >= 2) {
    return { yes: true, why: `含 ${actions} 个动作、${distinct} 类能力，拆分后可以并行省时` }
  }
  return {
    yes: false,
    why: actions <= 2
      ? '任务单一，拆分只会增加分解费和汇总费，不如直接交给最合适的那个模型'
      : '虽然动作多，但都属于同一类能力，单模型一次做完更连贯、更省',
  }
}

/**
 * 估算一个子任务的输入规模（字符数），用于成本预估。
 *
 * @param {object} subtask - one planned subtask.
 * @param {string} task - the overall task text.
 * @returns {number} estimated input characters.
 */
export function estimateInputChars(subtask, task) {
  const own = String(subtask?.instruction || '').length + String(subtask?.needs || '').length
  const upstream = (subtask?.depends_on || []).reduce((sum, id) => {
    const dep = String(subtask.__upstream?.[id] || '')
    return sum + dep.length
  }, 0)
  // 只有上游产出被截断后带进来，主任务原文不重复带给每个子任务。
  return own + upstream + Math.min(String(task || '').length, 200)
}

/**
 * 给一个子任务挑模型。
 *
 * 步骤：
 *   1. 按能力门槛过滤出候选池（能力是硬门槛）
 *   2. 候选里按 `costMultiplier` 升序（同价按能力分降序，同能力同价按上下文窗口降序）
 *   3. 若候选为空，放宽一档门槛再试；仍为空则报"无可用模型"
 *
 * @param {object} kind - subtask kind.
 * @param {object} catalog - catalog snapshot from `buildCatalog`.
 * @param {object} policy - routing policy (floors, overrides, forced models).
 * @param {object} [options] - selection options.
 * @param {boolean} [options.forceStrong] - ignore cost, pick the most capable model.
 * @param {string} [options.pin] - pin to a specific model reference.
 * @returns {object|null} the chosen model, or null when nothing qualifies.
 */
export function pickModel(kind, catalog, policy, options = {}) {
  const models = catalog?.models ?? []
  if (models.length === 0) return null

  // 用户显式指定模型时，直接服从，不做能力门槛判断。
  if (options.pin) {
    const pinned = models.find((m) => modelMatches(m, options.pin))
    if (pinned) return pinned
  }

  const capability = KIND_TO_CAPABILITY[kind] || 'reasoning'
  const floor = policy?.floors?.[kind] ?? policy?.floors?.[capability] ?? 3

  const score = (model) => {
    const overrides = policy?.capabilityOverrides?.[model.model] ?? policy?.capabilityOverrides?.[model.name]
    const value = overrides?.[capability]
    if (typeof value === 'number') return value
    if (capability === 'vision') {
      // 视觉能力是客观的：模型声明支持图片才算有视觉能力。
      return model.supportsImage ? 5 : 0
    }
    if (capability === 'reasoning') {
      if (model.reasoningEfforts.length > 0) return 5
      return 3
    }
    if (capability === 'longdoc') {
      const window = model.contextWindow ?? 0
      if (window >= 200000) return 5
      if (window >= 100000) return 4
      return 3
    }
    if (capability === 'coding') {
      const window = model.contextWindow ?? 0
      if (window >= 100000) return 4
      return 3
    }
    return 3
  }

  const scored = models
    .map((model) => ({ model, capability: score(model) }))
    .filter((entry) => entry.capability > 0)

  const qualifies = scored.filter((entry) => entry.capability >= floor)

  const qualityMode = policy?.qualityMode ?? 'balanced'
  const order = (a, b) => {
    if (options.forceStrong || qualityMode === 'quality-first') {
      // 质量优先：能力硬门槛之后，先选能力更高、上下文更大的模型；
      // 只有能力完全相同时才用相对成本做裁决。
      if (b.capability !== a.capability) return b.capability - a.capability
      const windowDelta = (b.model.contextWindow ?? 0) - (a.model.contextWindow ?? 0)
      if (windowDelta !== 0) return windowDelta
      return (a.model.costMultiplier ?? 1) - (b.model.costMultiplier ?? 1)
    }
    // balanced / credit-saver：能力达标后按成本升序，同价再按能力、上下文。
    if (a.model.costMultiplier !== b.model.costMultiplier) {
      return a.model.costMultiplier - b.model.costMultiplier
    }
    if (b.capability !== a.capability) return b.capability - a.capability
    return (b.model.contextWindow ?? 0) - (a.model.contextWindow ?? 0)
  }

  const pool = qualifies.length > 0 ? qualifies : []
  if (pool.length === 0) {
    // 门槛太高：放宽到"能力最高的那些里最便宜的"。
    const best = scored.reduce((max, entry) => Math.max(max, entry.capability), 0)
    if (best === 0) return null
    const relaxed = scored.filter((entry) => entry.capability >= best - 1)
    return [...relaxed].sort(order)[0]?.model ?? null
  }
  return [...pool].sort(order)[0].model
}

/**
 * 汇总环节用的模型：必须够强，否则只会机械拼接。
 *
 * 与普通子任务不同，汇总**不看成本**——它决定了最终交付物的质量。
 *
 * @param {object} catalog - catalog snapshot.
 * @param {object} policy - routing policy.
 * @returns {object|null} the synthesis model.
 */
export function pickSynthesisModel(catalog, policy) {
  const models = catalog?.models ?? []
  if (models.length === 0) return null

  // 显式配置了汇总模型就用它。
  const configured = policy?.synthesisModel
  if (configured) {
    const hit = models.find((m) => modelMatches(m, configured))
    if (hit) return hit
  }

  const score = (model) => {
    const overrides = policy?.capabilityOverrides?.[model.model] ?? policy?.capabilityOverrides?.[model.name]
    const value = overrides?.['writing']
    if (typeof value === 'number') return value
    const window = model.contextWindow ?? 0
    if (window >= 200000) return 5
    if (window >= 100000) return 4
    return 3
  }

  const scored = models
    .map((model) => ({ model, capability: score(model) }))
    .filter((entry) => entry.capability > 0)

  if (scored.length === 0) return null
  // 汇总不看成本：先按能力，再按上下文窗口，最后才用成本做同分裁决。
  scored.sort((a, b) => {
    if (b.capability !== a.capability) return b.capability - a.capability
    const windowDelta = (b.model.contextWindow ?? 0) - (a.model.contextWindow ?? 0)
    if (windowDelta !== 0) return windowDelta
    return a.model.costMultiplier - b.model.costMultiplier
  })
  return scored[0].model
}

/**
 * 计算一个模型跑一段上下文的估算成本。
 *
 * 口径：以 creditMultiplier 为相对成本单位。倍率 0 就是 0（免费），
 * 倍率 0.29 的模型跑同样的 token 花费是标准价的 29%。
 *
 * @param {object} model - catalog model.
 * @param {number} inputChars - estimated input characters.
 * @param {number} outputChars - estimated output characters.
 * @returns {number} relative cost units.
 */
export function estimateCost(model, inputChars, outputChars) {
  if (!model) return 0
  // 粗略换算：中文与英文混排下约 3 字符 ≈ 1 token。
  const inputTokens = Math.ceil(inputChars / 3)
  const outputTokens = Math.ceil(outputChars / 3)
  const relative = (inputTokens * 1 + outputTokens * 3) / 1000
  return Number((relative * (model.costMultiplier ?? 1)).toFixed(6))
}

/**
 * 汇总某个子任务集合的估算成本。
 *
 * @param {object[]} subtasks - planned subtasks.
 * @param {object} catalog - catalog snapshot.
 * @param {object} policy - routing policy.
 * @param {string} task - overall task text.
 * @returns {number} estimated relative cost.
 */
export function estimatePlanCost(subtasks, catalog, policy, task) {
  let total = 0
  for (const subtask of subtasks) {
    const model = pickModel(subtask.kind, catalog, policy)
    if (!model) continue
    const chars = estimateInputChars(subtask, task)
    total += estimateCost(model, chars, Math.min(chars * 0.5, 2000))
  }
  // 分解费 + 汇总费。
  const planner = pickModel('reasoning', catalog, policy, { forceStrong: true })
  const synth = pickSynthesisModel(catalog, policy)
  total += estimateCost(planner, task.length, 800)
  total += estimateCost(synth, subtasks.length * 600, 1500)
  return Number(total.toFixed(6))
}

/**
 * 判断是否需要抬高能力门槛（用户措辞要求高准确度）。
 *
 * @param {string} task - task description.
 * @returns {boolean} whether to force the strongest models.
 */
export function requiresStrong(task) {
  const text = String(task || '')
  return rulesFor(text).strong.test(text)
}

export { CAPABILITIES }
