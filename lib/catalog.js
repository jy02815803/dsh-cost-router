/**
 * cost-router — 模型目录发现与能力画像。
 *
 * 设计要点：本文件不做任何"猜测模型强弱"的事，只从 DSH 已经注册好的
 * 提供方目录里**读出客观事实**，再由配置做主观覆盖。
 *
 * 客观事实有三个来源：
 *   1. `ctx.llm.listProviders()`   —— 已注册且可用的 provider 路由
 *   2. `ctx.llm.listModels(p)`     —— 每个 provider 的模型目录，含
 *      `inputModalities`（是否支持图片）、`contextWindow`
 *   3. `ctx.llm.resolveModelInfo(p,m)` —— 精确模型的上下文窗口与推理档位
 *
 * 成本口径来自用户所在渠道的 settings：
 *   - workbuddy 系的 `creditMultiplier === 0` 就是真免费
 *   - 模型名里带 "Free" 的也是免费
 *   - 其余按 creditMultiplier 折算成相对成本
 *
 * @module dsh-cost-router/catalog
 */

/** 能力维度。路由表里的 `floor` 按这些维度给每个子任务设能力门槛。 */
export const CAPABILITIES = ['vision', 'reasoning', 'writing', 'coding', 'toolcall', 'longdoc', 'bulk']

/** 从模型目录里能客观读出的模态。 */
const IMAGE_MODALITY = 'image'

/**
 * 归一化 provider 路由名。DSH 的 provider id 就是渠道 id（`workbuddy`、`oc-ferry`…）。
 * @param {string} id - provider route id.
 * @returns {string} normalized id.
 */
export function normalizeProviderId(id) {
  return String(id || '').trim()
}

/**
 * 判断一个模型名是否标称免费。
 *
 * 依据是**用户所在渠道自己声明**的免费标记：workbuddy 用
 * `creditMultiplier === 0`，其余渠道在模型名里带 `Free`。
 * @param {string} modelName - model display name.
 * @returns {boolean} whether the model is advertised as free.
 */
export function looksFree(modelName) {
  return /\bfree\b/i.test(String(modelName || ''))
}

/**
 * 从 settings 的描述树里找出某个 provider 的模型目录。
 *
 * DSH 的 settings 描述按 Loader 条目 id 分命名空间，workbuddy 的模型目录
 * 挂在它自己的条目下，形状是 `regions.<region>.lastCatalog[]`，每个条目带
 * `id` / `name` / `creditMultiplier` / `contextWindow` / `supportsImages`。
 *
 * 这个函数走的是**结构化查找**，不解析 YAML 文本，也不猜字段名。
 * @param {object} settingsValue - one settings descriptor's `value` tree.
 * @returns {Map<string, object>} model id → catalog entry.
 */
export function collectCatalogEntries(settingsValue) {
  const out = new Map()
  if (!settingsValue || typeof settingsValue !== 'object') return out

  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    // 一个模型目录条目：必须有字符串 id，且带名字或倍率之一。
    if (typeof node.id === 'string' && node.id.length > 0 &&
      (typeof node.name === 'string' || typeof node.creditMultiplier === 'number')) {
      out.set(node.id, node)
    }
    for (const value of Object.values(node)) visit(value)
  }
  visit(settingsValue)
  return out
}

/**
 * 从 settings 描述列表里汇总所有 provider 的模型目录。
 *
 * @param {Array<object>} descriptors - `ctx.settings.describe()` 的返回值。
 * @returns {Map<string, Map<string, object>>} provider id → (model id → entry).
 */
export function collectCatalogsByProvider(descriptors) {
  const byProvider = new Map()
  if (!Array.isArray(descriptors)) return byProvider

  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor !== 'object') continue
    const ns = typeof descriptor.ns === 'string' ? descriptor.ns : ''
    if (ns.length === 0) continue

    // 条目 id 形如 `dsh-connect-workbuddy`；provider 路由名一般就是条目 id 本身，
    // 也可能是 `include:<id>`。两种都收下，让调用方按 provider 名精确匹配。
    const candidates = new Set([ns])
    const include = ns.startsWith('include:') ? ns.slice('include:'.length) : null
    if (include) candidates.add(include)

    const entries = collectCatalogEntries(descriptor.value)
    if (entries.size === 0) continue
    for (const candidate of candidates) {
      if (byProvider.has(candidate)) continue
      byProvider.set(candidate, entries)
    }
  }
  return byProvider
}

/**
 * 从一个渠道目录条目里读出成本倍率。
 *
 * `creditMultiplier` 是 workbuddy 系的唯一口径：0 = 真免费，0.29 = 折扣，
 * 3.31 = 溢价。没有这个字段的模型按 `1` 记，即"标准价"，绝不当作免费。
 *
 * @param {object|undefined} entry - one catalog entry.
 * @returns {number} cost multiplier, 0 means free.
 */
export function readMultiplier(entry) {
  if (!entry || typeof entry !== 'object') return 1
  const value = entry.creditMultiplier
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 1
  return value
}

/**
 * 构建一次性的模型目录快照。
 *
 * 快照是"某一时刻 DSH 里可用的模型"的完整描述，之后所有路由决策都基于它，
 * 不再回访 provider —— 这样一次 plan/run 里的所有子任务看到同一份视图，
 * 不会出现前一个子任务用过的模型在后面消失。
 *
 * @param {object} ctx - Cordis context carrying `llm` and optionally `settings`.
 * @param {object} [options] - discovery options.
 * @param {string[]} [options.onlyProviders] - restrict to these provider ids.
 * @param {AbortSignal} [options.signal] - cancellation for model lookups.
 * @returns {Promise<object>} the catalog snapshot.
 */
export async function buildCatalog(ctx, options = {}) {
  const llm = ctx.get('llm')
  if (!llm) {
    throw new Error('cost-router 需要 DSH 的 llm 服务（@deepseek-ai/dsh-llm），但它没有挂载。')
  }

  let settingsDescriptors = []
  try {
    const settings = ctx.get('settings')
    if (settings && typeof settings.describe === 'function') {
      settingsDescriptors = settings.describe({ redactSecrets: true }) || []
    }
  } catch {
    // settings 读不到不影响路由，只是拿不到渠道价格表。
  }
  const catalogs = collectCatalogsByProvider(settingsDescriptors)

  const providers = llm.listProviders()
  const wanted = options.onlyProviders && options.onlyProviders.length > 0
    ? new Set(options.onlyProviders.map(normalizeProviderId))
    : null

  const models = []
  const seen = new Set()

  for (const provider of providers) {
    const providerId = normalizeProviderId(provider.id)
    if (providerId.length === 0) continue
    if (wanted && !wanted.has(providerId)) continue

    let listed = []
    try {
      listed = await llm.listModels(providerId)
    } catch {
      // 一个 provider 列举失败不影响其他 provider。
      continue
    }

    const channelCatalog = catalogs.get(providerId)

    for (const info of listed) {
      const modelId = typeof info.id === 'string' ? info.id : ''
      if (modelId.length === 0) continue
      const key = `${providerId}::${modelId}`
      if (seen.has(key)) continue
      seen.add(key)

      const entry = channelCatalog ? channelCatalog.get(modelId) : undefined
      const name = typeof info.name === 'string' && info.name.length > 0 ? info.name : modelId
      const modalities = Array.isArray(info.inputModalities) ? info.inputModalities : []
      const multiplier = entry ? readMultiplier(entry) : (looksFree(name) ? 0 : 1)

      // 精确模型信息：上下文窗口与推理档位。失败不致命，退回目录值。
      let resolved = undefined
      try {
        resolved = await llm.resolveModelInfo(providerId, modelId, options.signal)
      } catch {
        resolved = undefined
      }

      models.push({
        provider: providerId,
        model: modelId,
        name,
        description: typeof info.description === 'string' ? info.description : undefined,
        supportsImage: modalities.includes(IMAGE_MODALITY),
        inputModalities: modalities,
        contextWindow: resolved?.context?.contextWindow ??
          (entry && typeof entry.contextWindow === 'number' ? entry.contextWindow : undefined),
        maxTokens: resolved?.defaultMaxTokens ??
          (entry && typeof entry.maxTokens === 'number' ? entry.maxTokens : undefined),
        reasoningEfforts: resolved?.reasoning?.efforts?.map((e) => e.id) ?? [],
        costMultiplier: multiplier,
        // 双重判定：倍率 0（渠道声明免费）或模型名带 Free 都算免费。
        // 注意这意味着"倍率为 1 但名字里恰好有 free"的模型也会被标成免费并优先选用，
        // 这是刻意的：这些通常是渠道自己命名的免费额度模型，宁可试错也不多花钱。
        free: multiplier === 0 || looksFree(name),
        fromCatalog: Boolean(entry),
      })
    }
  }

  return {
    models,
    providers: providers.map((p) => ({ id: normalizeProviderId(p.id), name: p.name })),
    takenAt: new Date().toISOString(),
  }
}

/**
 * 按模型 id 或显示名做宽松匹配。
 *
 * 用户在配置里写模型时，写的是渠道里看到的名字（"Hy3"、"GLM-5.3-Flash"），
 * 而 DSH 的路由用的是精确 id。所以两级匹配都要支持。
 *
 * @param {object} model - one catalog model.
 * @param {string} query - user-provided model reference.
 * @returns {boolean} whether the model matches.
 */
export function modelMatches(model, query) {
  const q = String(query || '').trim().toLowerCase()
  if (q.length === 0) return false
  if (model.model.toLowerCase() === q) return true
  if (model.name.toLowerCase() === q) return true
  if (model.provider.toLowerCase() === q) return true
  return model.model.toLowerCase().includes(q) || model.name.toLowerCase().includes(q)
}
