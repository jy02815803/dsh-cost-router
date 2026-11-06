/**
 * 0.7.0 同源控制路由：让用户从界面显式触发 plan / run / cancel。
 *
 * 这不是自动执行：所有可能产生模型费用的动作都必须带 `confirm: true`
 * 且由用户点击发起。run 还需要一个由 plan 产生的 planId，避免误触重新分解。
 *
 * @module dsh-cost-router/control
 */

/**
 * 注册控制路由。
 *
 * GET  /dsh-cost-router/control → 最近研判、方案卡片、运行状态
 * POST /dsh-cost-router/control ← { action, task?, planId?, confirm? }
 *   action: plan | run | cancel
 *
 * @param {object} ctx - injected webServer context.
 * @param {object} options - runtime services.
 * @returns {void}
 */
export function registerControlRoute(ctx, options = {}) {
  const webServer = ctx?.webServer
  if (typeof webServer?.register !== 'function') throw new Error('注入的 webServer 缺少 register()')

  const {
    fenceRequest,
    sendJson,
    readBody,
    getRuntime,
    Orchestrator,
    planCard,
    renderPlanText,
    policy,
    config,
    liveState,
    privacyAudit,
    orchestrator,
    recordError,
    collectSessionImages,
  } = options

  const active = new Map()
  const runtime = getRuntime()
  const warn = (message, error) => {
    try {
      const fn = ctx?.logger?.warn
      if (typeof fn === 'function') fn.call(ctx.logger, message, error)
      else console.warn(message, error)
    } catch {
      // 日志失败不影响控制路由。
    }
  }
  const send = (res, status, value) => sendJson(res, status, value)
  const newRun = () => new Orchestrator(ctx, policy, {
    freeOnly: config?.freeOnly === true,
    maxMultiplier: config?.maxMultiplier,
    ...(Number.isFinite(Number(config?.defaultBudget)) ? { defaultBudget: Number(config.defaultBudget) } : {}),
    planStore: runtime.planStore,
    audit: privacyAudit,
    explain: true,
    qualityMode: liveState.qualityMode ?? 'balanced',
  })

  const snapshot = () => ({
    executionMode: 'manual',
    autoExecute: false,
    surfaceVerdict: liveState.surfaceVerdict !== false,
    qualityMode: liveState.qualityMode ?? 'balanced',
    lastVerdict: runtime.lastVerdict ?? null,
    lastPlanCard: runtime.lastPlanCard ?? null,
    lastRunCard: runtime.lastRunCard ?? null,
    activeRuns: active.size,
    pendingPlans: runtime.planStore?.size ?? 0,
    lastError: runtime.lastError ?? null,
  })

  const handle = async (req, res) => {
    const rejection = fenceRequest(req)
    if (rejection !== undefined) return send(res, 403, { error: rejection })

    if (req.method === 'GET' || req.method === 'HEAD') {
      return sendJson(res, 200, snapshot(), req.method === 'HEAD')
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' })

    const bodyResult = await readBody(req)
    if (bodyResult.tooLarge) return send(res, 413, { error: 'request-body-too-large' })
    const body = bodyResult?.value ?? {}
    const action = String(body.action ?? '')
    if (!['plan', 'run', 'cancel'].includes(action)) return send(res, 400, { error: 'unknown-action' })
    if (body.confirm !== true) return send(res, 400, { error: 'confirmation-required' })

    if (action === 'cancel') {
      const runId = String(body.runId ?? '')
      const controller = active.get(runId)
      if (!controller) return send(res, 404, { error: 'run-not-found' })
      controller.abort()
      return send(res, 200, { ok: true, runId, cancelled: true })
    }

    const task = String(body.task ?? '').trim().slice(0, 12000)
    if (!task) return send(res, 400, { error: 'task-required' })

    const runId = `ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const controller = new AbortController()
    active.set(runId, controller)
    runtime.lastRunCard = {
      version: 1,
      runId,
      at: new Date().toISOString(),
      action,
      stage: 'starting',
      status: 'running',
      model: null,
      estimated: 0,
      actual: 0,
      message: action === 'plan' ? '正在生成方案' : '正在执行方案',
      hasTaskText: false,
    }

    try {
      if (action === 'plan') {
        const plan = await newRun().plan({ task, signal: controller.signal })
        const card = planCard(plan, { qualityMode: liveState.qualityMode ?? 'balanced' })
        runtime.lastPlanCard = card
        runtime.lastRunCard = {
          ...runtime.lastRunCard,
          stage: 'plan-done',
          status: 'done',
          message: renderPlanText({ ...plan, card }),
        }
        send(res, 200, { ok: true, runId, action, card, plan: { ...plan, card } })
      } else {
        const planId = String(body.planId ?? '').trim()
        if (!planId) return send(res, 400, { error: 'planId-required' })
        if (!runtime.planStore?.plans?.has(planId)) return send(res, 404, { error: 'plan-not-found' })
        const result = await newRun().run({
          task,
          planId,
          signal: controller.signal,
          images: typeof collectSessionImages === 'function' ? collectSessionImages(null, 8) : [],
        })
        runtime.lastRunCard = {
          ...runtime.lastRunCard,
          stage: 'run-done',
          status: 'done',
          model: result?.model ?? null,
          estimated: Number(result?.cost?.estimate?.estimated ?? 0),
          actual: Number(result?.cost?.totalCost ?? 0),
          message: `执行完成：${result?.mode ?? 'unknown'}`,
        }
        send(res, 200, { ok: true, runId, action, result })
      }
    } catch (error) {
      recordError(error)
      const aborted = error?.name === 'AbortError'
      runtime.lastRunCard = {
        ...runtime.lastRunCard,
        stage: aborted ? 'cancelled' : 'failed',
        status: aborted ? 'cancelled' : 'failed',
        message: String(error?.message ?? error).slice(0, 200),
      }
      send(res, aborted ? 499 : 500, { error: aborted ? 'cancelled' : 'control-failed', detail: runtime.lastRunCard.message })
    } finally {
      active.delete(runId)
    }
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-cost-router/control',
    handler: async (req, res) => {
      try {
        await handle(req, res)
      } catch (error) {
        warn('dsh-cost-router: 控制请求处理失败:', error)
        if (!res.headersSent) send(res, 500, { error: 'internal-error' })
        else if (!res.writableEnded) res.end()
      }
    },
  }), 'dsh-cost-router: control route')
}