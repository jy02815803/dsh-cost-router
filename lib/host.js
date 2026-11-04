/**
 * cost-router — Host 插件入口。
 *
 * 这个插件把 DSH 里**已经配置好的模型渠道**变成一个调度器：
 *   1. 先研判任务该不该拆（异构判定，纯规则，不花钱）
 *   2. 拆开后按子任务的能力需求匹配模型（能力是门槛，成本是目标）
 *   3. 执行、汇总、逐笔记账
 *
 * 关键设计：**不自己配 API key**。所有模型都来自 `ctx.llm` 已注册的 provider，
 * 也就是用户 DSH 里本来就有的渠道（免费渠道也在其中）。成本口径取自这些
 * 渠道自己声明的倍率（creditMultiplier === 0 就是真免费）。
 *
 * @module dsh-cost-router
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { Orchestrator } from './orchestrator.js'
import { buildCatalog } from './catalog.js'
import { installAutoPlan } from './auto-plan.js'
import { readPersistedState, resolveInitialEnabled, resolveStatePath, writePersistedState } from './state.js'
import { getRuntime, recordError } from './runtime.js'
import { classify, isHeterogeneous, pickModel, pickSynthesisModel } from './router.js'
import { readFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** 插件行名。与包名保持一致，避免与其他插件的行 id 冲突。 */
export const name = 'dsh-cost-router'

/**
 * 硬依赖。
 *
 * - `tools`：注册面向模型的四个工具
 * - `llm`：调用模型（没有它这个插件无事可做）
 *
 * 服务名必须与各包 `super(ctx, '<name>')` 完全一致：`tools` / `llm`。
 *
 * `skills` 刻意**不**放进 inject：它是可选增强。DSH 的组合里通常都挂了
 * skill 注册表（base 的 `id: skill` 行），但把可选服务写进必需的 inject，
 * 会让插件在缺少它时永远停在等待状态、整个插件都不工作——为了一个
 * 提示词而牺牲全部功能不划算。所以这里在 apply 内部探测，缺了就跳过技能注册。
 */
export const inject = ['tools', 'llm']

/**
 * 插件配置。
 *
 * `autoPlan` 是自动研判开关：打开后每条任务先做一次免费的规则研判，
 * 决定「直接单模型做」还是「建议拆分」。
 *
 * 默认**开启**：目标用户是「不懂模型、只想把积分省着用」的人，
 * 装完就能工作才符合预期；懂行的人知道去哪关。
 *
 * 注意：界面上改这个开关走的是 `lib/state.js` 的独立状态文件，
 * **不需要重启**。这里的默认值只在状态文件还没有记录时用作初值。
 */
export const Config = z.object({
  autoPlan: z.object({
    enabled: z
      .boolean()
      .default(true)
      .description('自动研判：打开后每条任务先判断该不该拆分。研判本身不花钱。'),
    minChars: z
      .number()
      .step(1)
      .min(1)
      .default(12)
      .description('少于这么多字的消息不做研判（避免每句「好的」都触发）。'),
  }).default({ enabled: true, minChars: 12 }),
  freeOnly: z.boolean().default(false).description('仅允许倍率为 0 的免费模型；默认关闭。'),
  maxMultiplier: z.number().min(0).default(10).description('允许调用的模型最大成本倍率；10 表示允许到 10 倍。'),
})

/** 插件所在目录（用于读内嵌的 SKILL.md 与默认策略）。 */
const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 从包内读版本，避免诊断信息与 package.json 漂移。 */
const packageJson = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))

/** 默认路由策略。用户可在配置里覆盖。 */
const DEFAULT_POLICY = {
  /** 各类任务的能力门槛。视觉不可降。 */
  floors: {
    vision: 5,
    longdoc: 3,
    reasoning: 4,
    code: 4,
    writing: 4,
    text: 3,
    bulk: 3,
  },
  /** 手动指定某个模型的能力评分。键是模型 id 或显示名。 */
  capabilityOverrides: {},
  /** 手动指定汇总模型。 */
  synthesisModel: undefined,
  /** 只在这些 provider 里选模型。省略表示全部。 */
  onlyProviders: undefined,
}

/**
 * 读默认策略文件。
 *
 * 策略文件是可选的：缺失时用内置默认值，插件照常工作。
 * @returns {object} the merged policy.
 */
function loadPolicy() {
  let filePolicy = {}
  try {
    const raw = readFileSync(path.join(HERE, '..', 'config', 'policy.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') filePolicy = parsed
  } catch {
    // 没有策略文件是正常情况。
  }
  return {
    ...DEFAULT_POLICY,
    ...filePolicy,
    floors: { ...DEFAULT_POLICY.floors, ...(filePolicy.floors || {}) },
    capabilityOverrides: { ...DEFAULT_POLICY.capabilityOverrides, ...(filePolicy.capabilityOverrides || {}) },
  }
}

/**
 * 从调用方会话里取出图片附件。
 *
 * 这是修掉"视觉任务拿不到图"的关键：会话里的用户消息带着图片内容块，
 * 附件是持久引用（attachmentId / mediaType / 宽高），直接复用它们，
 * 由 DSH 的提供方适配器负责投影成各路由要的尺寸。
 *
 * @param {object} exec - tool execution context.
 * @param {number} limit - maximum number of images to carry.
 * @returns {Array<object>} image blocks to attach to a subtask message.
 */
function collectSessionImages(exec, limit) {
  const agent = exec?.agent
  if (!agent?.session) return []
  try {
    const messages = agent.session.deriveMessages()
    const blocks = []
    for (const message of messages) {
      if (message.role !== 'user' && message.role !== 'developer') continue
      for (const block of message.content || []) {
        if (block.type !== 'image') continue
        blocks.push(block)
        if (blocks.length >= limit) return blocks
      }
    }
    return blocks
  } catch (error) {
    recordError(error)
    // 取图失败只影响视觉子任务，不让整次 run 失败；但留痕便于排查。
    console.warn('[dsh-cost-router] 读取会话图片失败:', error)
    return []
  }
}

/**
 * 请求收口：只答回环调用者，且 Origin（若提供）必须与 Host 同源。
 *
 * 本路由能改开关状态，所以这条防护比只读路由更要紧：没有它，本机任意
 * 网页都能替用户改配置。
 *
 * @param {object} req - HTTP 请求。
 * @returns {string|undefined} 拒绝原因；undefined 表示放行。
 */
function fenceRequest(req) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    return 'forbidden-host'
  }
  const origin = req.headers?.origin
  if (typeof origin === 'string' && origin !== 'null') {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      return 'bad-origin'
    }
    if (originHost !== host) return 'cross-origin'
  }
  return undefined
}

/**
 * 注册界面开关的读写接口。
 *
 * 浏览器半身（`lib/client.js`）用这个接口读当前开关、并在用户点击时写回。
 * 写回会同时更新内存里的 `liveState`（立即生效）和状态文件（重启后保留）。
 *
 * - `GET  /dsh-cost-router/state` → `{ enabled, minChars, persisted }`
 * - `POST /dsh-cost-router/state` ← `{ enabled, minChars? }` → 同上
 *
 * 调用方必须先通过 `ctx.inject(['webServer'], ...)` 等待服务发布，再把已注入的
 * 上下文传进来。这里不再做一次性的 `get('webServer')` 探测：DSH 的 Host 插件
 * 往往先于 webServer 加载，探测会在服务尚未公布时失败，并让路由永久缺失。
 *
 * @param {object} ctx - Cordis context.
 * @param {object} liveState - 可变开关状态对象。
 * @returns {void}
 */
function registerStateRoute(ctx, liveState, diagnostics = {}) {
  const webServer = ctx?.webServer
  if (typeof webServer?.register !== 'function') {
    throw new Error('注入的 webServer 缺少 register()')
  }

  const warn = (message, error) => {
    try {
      const loggerWarn = ctx?.logger?.warn
      if (typeof loggerWarn === 'function') loggerWarn.call(ctx.logger, message, error)
      else console.warn(message, error)
    } catch {
      // 日志失败不能反过来打断请求或插件。
    }
  }

  const sendJson = (res, status, value, headOnly = false) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    // HEAD 必须与 GET 同状态、同头部，但不能传输响应体。
    res.end(headOnly ? undefined : JSON.stringify(value))
  }

  const snapshot = () => readStateSnapshot(liveState)

  /** 只暴露可排障字段，不返回任务正文、token 或模型凭据。 */
  const diagnosticSnapshot = () => ({
    version: diagnostics.version ?? 'unknown',
    stateRoute: '/dsh-cost-router/state',
    webServer: true,
    configSource: diagnostics.configSource ?? 'unknown',
    statePath: diagnostics.stateConfigured ? '<configured>' : '<memory-only>',
    tools: diagnostics.tools ?? [],
    autoPlan: { enabled: liveState.enabled, minChars: liveState.minChars, dryRun: liveState.dryRun === true },
    freeOnly: diagnostics.freeOnly === true,
    maxMultiplier: diagnostics.maxMultiplier ?? 10,
    startedAt: diagnostics.runtime?.startedAt ?? null,
    pendingPlans: diagnostics.runtime?.planStore?.size ?? 0,
    lastError: diagnostics.runtime?.lastError ?? null,
  })


  /** 读请求体（按 UTF-8 字节数设上限，避免多字节字符绕过限额）。 */
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      let bytes = 0
      let tooLarge = false
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const toBuffer = (chunk) => {
        if (Buffer.isBuffer(chunk)) return chunk
        if (ArrayBuffer.isView(chunk)) {
          return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        }
        return Buffer.from(String(chunk ?? ''), 'utf8')
      }
      req.on('data', (chunk) => {
        if (tooLarge) return
        const buffer = toBuffer(chunk)
        bytes += buffer.byteLength
        if (bytes > 4096) {
          // 继续消费剩余数据，让服务端还能正常发送 413；不 destroy 请求，
          // 否则响应连接被切断，Promise 也可能永远等不到 end。
          tooLarge = true
          chunks.length = 0
          return
        }
        chunks.push(buffer)
      })
      req.on('end', () => {
        if (tooLarge) {
          finish({ tooLarge: true })
          return
        }
        const raw = Buffer.concat(chunks).toString('utf8')
        try {
          finish({ value: JSON.parse(raw === '' ? '{}' : raw) })
        } catch {
          finish({ value: {} })
        }
      })
      req.on('error', () => finish({ value: {} }))
      req.on('aborted', () => finish({ value: {} }))
    })

  const handle = async (req, res) => {
    // 这个路由能**写**状态，因此必须收口：只答回环调用者，且 Origin 同源。
    // 否则本机任意网页都能改你的开关。
    const rejection = fenceRequest(req)
    if (rejection !== undefined) {
      sendJson(res, 403, { error: rejection })
      return
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const pathname = (() => {
        try {
          const value = new URL(req.url ?? '/', 'http://localhost').pathname
          return value === '/diagnostics' || value.endsWith('/diagnostics') ? '/diagnostics' : value
        } catch {
          return '/'
        }
      })()
      const value = pathname === '/diagnostics' ? diagnosticSnapshot() : snapshot()
      sendJson(res, 200, value, req.method === 'HEAD')
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' })
      return
    }

    const bodyResult = await readBody(req)
    if (bodyResult.tooLarge) {
      sendJson(res, 413, { error: 'request-body-too-large' })
      return
    }
    const body = bodyResult.value
    if (typeof body?.enabled !== 'boolean') {
      sendJson(res, 400, { error: 'enabled must be a boolean' })
      return
    }
    if (
      body.minChars !== undefined &&
      (typeof body.minChars !== 'number' || !Number.isFinite(body.minChars) || body.minChars < 1)
    ) {
      sendJson(res, 400, { error: 'minChars must be a finite number >= 1' })
      return
    }

    liveState.enabled = body.enabled
    if (body.minChars !== undefined) liveState.minChars = Math.floor(body.minChars)

    // 内存已改（立即生效），再尽力落盘（重启后仍保留）。
    const persisted = writePersistedState({ enabled: liveState.enabled, minChars: liveState.minChars })
    sendJson(res, 200, { ...snapshot(), persisted })
  }

  const handler = async (req, res) => {
    try {
      await handle(req, res)
    } catch (error) {
      warn('dsh-cost-router: 开关状态请求处理失败:', error)
      try {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal-error' })
        else if (!res.writableEnded) res.end()
      } catch {
        // 响应已断开时只能记录，不能把异常抛回宿主 HTTP 循环。
      }
    }
  }

  // effect 持有 route 的 disposer：服务替换或插件卸载时自动移除，避免重复路由。
  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: '/dsh-cost-router/state',
      handler,
    }),
    'dsh-cost-router: state route',
  )
}

/**
 * 给界面返回一个开关状态快照。
 *
 * @param {object} liveState - 可变开关状态对象。
 * @returns {{enabled: boolean, minChars: number, persisted: boolean}}
 */
function readStateSnapshot(liveState) {
  const persistedState = readPersistedState()
  const persisted = persistedState.enabled !== undefined || persistedState.minChars !== undefined
  return {
    enabled: liveState?.enabled === true,
    minChars: typeof liveState?.minChars === 'number' ? liveState.minChars : 12,
    persisted,
  }
}

/**
 * 注册插件。
 *
 * 这是**唯一**的导出入口，并且刻意做成「绝不向外抛错」：
 * DSH 的启动审计把 apply 抛错判为插件失败，reconcile 又会据此自动禁用
 * 整个插件（缺服务只是 pending/警告，只有抛错才会被禁用）。因此这里把
 * 真正的注册逻辑包在 applyUnsafe 里，任何异常都就地降级成一条警告，
 * 让「插件自己坏了」不等于「DSH 起不来」。
 *
 * @param {object} ctx - Cordis context.
 * @param {object} config - deployment configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  try {
    applyUnsafe(ctx, config)
  } catch (error) {
    // 绝不让异常逃逸：工具/技能是增强能力，装不上就退化成「什么都没装」，
    // 而不是把宿主拖进安全模式、连带禁用本插件。
    try {
      const warn = ctx?.logger?.warn ?? ctx?.logger?.info
      if (typeof warn === 'function') {
        warn.call(ctx.logger, `dsh-cost-router: 初始化失败，已降级跳过：${error?.message ?? error}`)
      } else {
        console.warn(`dsh-cost-router: 初始化失败，已降级跳过：${error?.message ?? error}`)
      }
    } catch {
      // 连日志都打不出去时保持静默：此时唯一正确的行为是让宿主继续启动。
    }
  }
}

/**
 * 真正的注册逻辑。可能抛错，只允许被 apply() 调用。
 *
 * @param {object} ctx - Cordis context.
 * @param {object} config - deployment configuration.
 * @returns {void}
 */
function applyUnsafe(ctx, config) {
  const base = loadPolicy()
  const policy = {
    ...base,
    ...(config?.policy && typeof config.policy === 'object' ? config.policy : {}),
    // 自动研判开关：顶层 config.autoPlan 优先于 policy.json 里的同名段。
    autoPlan: {
      ...base.autoPlan,
      ...(config?.policy?.autoPlan && typeof config.policy.autoPlan === 'object' ? config.policy.autoPlan : {}),
      ...(config?.autoPlan && typeof config.autoPlan === 'object' ? config.autoPlan : {}),
    },
    // 下面三项都复用上面已经算好的 `base`，不再重复读盘（loadPolicy 每次都要 readFileSync）。
    floors: {
      ...base.floors,
      ...(config?.policy?.floors || {}),
    },
    capabilityOverrides: {
      ...base.capabilityOverrides,
      ...(config?.policy?.capabilityOverrides || {}),
    },
    onlyProviders: config?.onlyProviders ?? base.onlyProviders,
  }

  // ── 自动研判开关的实时状态 ────────────────────────────────────────────────
  //
  // 这是一个**可变对象**，钩子每次任务都读它，界面上改它立刻生效、无需重启。
  // 初值优先级：状态文件 > 插件配置 > 内置默认（默认开启）。
  const initial = resolveInitialEnabled(config)
  const liveState = {
    enabled: initial.enabled,
    dryRun: config?.dryRun === true,
    minChars:
      (typeof initial.minChars === 'number' ? initial.minChars : undefined) ??
      (typeof config?.autoPlan?.minChars === 'number' ? config.autoPlan.minChars : undefined) ??
      policy.autoPlan?.minChars ??
      12,
  }

  const orchestrator = new Orchestrator(ctx, policy, {
    freeOnly: config?.freeOnly === true,
    maxMultiplier: config?.maxMultiplier,
  })

  /**
   * 逐项注册的容错包装：单个工具/技能注册失败只丢那一个，
   * 不影响其余功能，更不影响宿主启动。
   *
   * @param {string} label - 出问题时写进警告的名字。
   * @param {() => unknown} run - 实际的注册动作。
   * @returns {void}
   */
  const guard = (label, run) => {
    try {
      run()
    } catch (error) {
      try {
        const warn = ctx?.logger?.warn
        if (typeof warn === 'function') {
          warn.call(ctx.logger, `dsh-cost-router: 注册 ${label} 失败，已跳过：${error?.message ?? error}`)
        }
      } catch {
        // 日志失败也不影响其余注册。
      }
    }
  }

  // ── 自动研判开关 ─────────────────────────────────────────────────────────
  // 钩子无条件挂上，开关判断在钩子内部实时做（见 auto-plan.js 的说明）。
  // 关闭时每次只多一次布尔判断，不调模型、不花钱。
  guard('自动研判钩子', () => installAutoPlan(ctx, liveState))

  // 界面开关的读写接口：浏览器半身（lib/client.js）通过它读写状态。
  // `webServer` 刻意不放进顶层 inject（没有 Web 服务的部署也必须能使用四个工具），
  // 而是在插件启动后晚绑定。服务尚未发布或稍后被替换时，Cordis 会保持/重跑回调。
  guard('开关状态接口', () =>
    ctx.inject(['webServer'], (webCtx) => {
      guard('开关状态路由', () => registerStateRoute(webCtx, liveState, {
        version: packageJson.version,
        configSource: initial.source,
        stateConfigured: resolveStatePath() !== null,
        tools: ['cost_router_plan', 'cost_router_run', 'cost_router_report', 'cost_router_models'],
        freeOnly: config?.freeOnly === true,
        maxMultiplier: config?.maxMultiplier ?? 10,
        runtime: getRuntime(),
      }))
    }),
  )

  // ── 工具：plan ────────────────────────────────────────────────────────────
  guard('cost_router_plan', () => ctx.tools.register(defineTool({
    name: 'cost_router_plan',
    description:
      '研判一个复杂任务该不该拆分、拆成几块、每块派给哪个模型、大概花多少钱。只做计划不执行，' +
      '用来在花钱前确认。适合同时涉及看图、长文档、代码、深度推理等多类能力的任务。',
    parameters: {
      task: { type: 'string', required: true, description: '用户的完整任务描述（原文）' },
      budget: { type: 'number', description: '本次任务的相对成本上限；0 表示完全免费' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      return await orchestrator.plan({
        task: args.task,
        ...(args.budget === undefined ? {} : { budget: args.budget }),
        ...(exec?.signal ? { signal: exec.signal } : {}),
      })
    },
    timeoutMs: 120000,
  })))

  // ── 工具：run ────────────────────────────────────────────────────────────
  guard('cost_router_run', () => ctx.tools.register(defineTool({
    name: 'cost_router_run',
    description:
      '按 cost_router_plan 的方案实际执行：分解、分派给各模型、汇总成稿，返回最终结果和真实花费。' +
      '确认方案后调用。',
    parameters: {
      task: { type: 'string', required: true, description: '用户的完整任务描述（原文）' },
      budget: { type: 'number', description: '相对成本上限；超出拒绝执行' },
      planId: { type: 'string', description: 'cost_router_plan 返回的方案 ID；传入后复用已确认方案，不重复分解' },
      freeOnly: { type: 'boolean', description: '仅使用倍率为 0 的免费模型；默认按插件配置' },
      maxMultiplier: { type: 'number', description: '本次允许调用的最大成本倍率' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const configured = new Orchestrator(ctx, policy, {
    freeOnly: args.freeOnly ?? (config?.freeOnly === true),
        maxMultiplier: args.maxMultiplier ?? config?.maxMultiplier,
        planStore: orchestrator.planStore,
      })
      return await configured.run({
        task: args.task,
        ...(args.budget === undefined ? {} : { budget: args.budget }),
        ...(args.planId === undefined ? {} : { planId: args.planId }),
        ...(exec?.signal ? { signal: exec.signal } : {}),
        // 会话里的图片随视觉子任务一起送进模型。
        images: collectSessionImages(exec, 8),
      })
    },
    timeoutMs: 600000,
  })))

  // ── 工具：report ─────────────────────────────────────────────────────────
  guard('cost_router_report', () => ctx.tools.register(defineTool({
    name: 'cost_router_report',
    description: '查看本次会话里 cost-router 的成本台账：逐次调用、各模型花费、合计相对成本。',
    parameters: {
      scope: { type: 'string', description: 'session（默认）查看会话累计；run 查看最近一次任务' },
      detail: { type: 'boolean', description: '是否返回逐次调用明细；默认关闭' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const scope = args?.scope === 'run' ? 'run' : 'session'
      return orchestrator.summary({ detail: args?.detail === true, scope })
    },
  })))

  // ── 工具：models ─────────────────────────────────────────────────────────
  // 让模型（和用户）看清"到底有哪些模型可用、哪些免费"，这是"免费优先"的
  // 可解释性基础。
  guard('cost_router_models', () => ctx.tools.register(defineTool({
    name: 'cost_router_models',
    description:
      '列出当前 DSH 里 cost-router 可用的模型：provider、模型名、是否支持图片、上下文窗口、' +
      '成本倍率（0 表示免费）。用来确认路由分配是否合理。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const catalog = await buildCatalog(ctx, {
        ...(policy.onlyProviders ? { onlyProviders: policy.onlyProviders } : {}),
        ...(exec?.signal ? { signal: exec.signal } : {}),
      })
      return {
        providers: catalog.providers,
        models: catalog.models
          .map((m) => ({
            provider: m.provider,
            model: m.model,
            name: m.name,
            supportsImage: m.supportsImage,
            contextWindow: m.contextWindow ?? null,
            costMultiplier: m.costMultiplier,
            free: m.free,
          }))
          .sort((a, b) => a.costMultiplier - b.costMultiplier),
        note: '成本倍率 0 = 该渠道声明的免费模型；倍率 1 = 标准价。',
      }
    },
    timeoutMs: 60000,
  })))

  // ── SKILL：让模型知道这套流程的用法与红线 ────────────────────────────────
  // 技能是可选增强：注册表不存在时跳过，四个工具照常工作。
  //
  // 注意这里用 ctx.get('skills') 探测、再用**探测到的句柄**注册，绝不能写
  // `ctx.skills`：`skills` 不在 inject 里，cordis 的属性代理对未 inject 的
  // 服务会直接抛 "cannot get property \"skills\" without inject"。而 DSH 的
  // reconcile 把「apply 抛错」判为新增失败并据此自动禁用整个插件（缺服务
  // 只是 pending/警告，抛错才会被禁用），所以这一行写错就等于重启即自残。
  // 详见 apply() 的容错包装。
  const skills = ctx.get('skills')
  if (skills && typeof skills.register === 'function') {
    const skillPath = path.join(HERE, '..', 'skills', 'cost-router', 'SKILL.md')
    let skillContent = ''
    try {
      skillContent = readFileSync(skillPath, 'utf8')
    } catch {
      skillContent = ''
    }
    if (skillContent.length > 0) {
      // 必须用上面探测到的 `skills` 句柄，理由见本节开头。
      guard('cost-router 技能', () => skills.register({
        name: 'cost-router',
        description:
          '把复杂任务拆成子任务，按能力匹配到最合适的模型（免费优先），最后统一汇总成稿，省成本提质量。' +
          '当任务同时涉及看图、长文档、代码、深度推理等多类能力，或用户明确要求省成本时使用。',
        whenToUse:
          '任务包含两种以上不同能力（视觉/长文档/代码/推理/写作），或用户说"省成本""用便宜的模型""拆开做"。',
        content: skillContent,
        source: 'dsh-cost-router',
        invocation: { modelInvocable: true, userInvocable: true },
      }))
    }
  }
}
