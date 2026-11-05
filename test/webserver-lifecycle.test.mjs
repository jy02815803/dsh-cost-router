/**
 * webServer 延迟注入与路由生命周期验收。
 *
 * 这个测试用最小 Cordis/DSH 桩模拟两类真实启动顺序：
 *   1. Host 插件先加载，webServer 尚未发布；
 *   2. webServer 稍后发布、被替换，以及插件卸载。
 *
 * 它验证四个工具不依赖 webServer，开关路由只在服务可用时注册，并在服务
 * 替换时由同一个注入回调重新注册、在卸载后清理。这里不启动 DSH、不调用
 * 模型、不访问网络，也不读写真实状态。
 *
 * 运行：node test/webserver-lifecycle.test.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'

const TOOLS_STUB_URL =
  'data:text/javascript,export function defineTool(spec)%7Breturn spec%7D'
const SCHEMASTERY_STUB_URL =
  'data:text/javascript,const z=new Proxy(function()%7B%7D,%7Bget()%7Breturn z%7D,apply()%7Breturn z%7D%7D);export default z'
const LLM_STUB_URL =
  'data:text/javascript,export function createUserMessage(input)%7Breturn%7Brole%3A%22user%22%2C...input%7D%7D'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') {
      return { url: TOOLS_STUB_URL, shortCircuit: true }
    }
    if (specifier === '@deepseek-ai/schemastery') {
      return { url: SCHEMASTERY_STUB_URL, shortCircuit: true }
    }
    if (specifier === '@deepseek-ai/dsh-llm') {
      return { url: LLM_STUB_URL, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

/**
 * 造一个最接近 Cordis 行为的宿主桩：inject 等待服务，effect 持有 disposer，
 * 服务替换会先清理旧作用域、再用同一个回调在新作用域上重跑。
 */
function createHost() {
  const tools = []
  const hooks = []
  const warnings = []
  const injections = []
  let currentWebServer
  let hasWebServer = false
  let publishCount = 0

  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {
          const index = tools.indexOf(tool)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    llm: {},
    logger: {
      warn(...args) {
        warnings.push(args)
      },
    },
    on(event, fn) {
      hooks.push({ event, fn })
    },
    get(name) {
      // skills 是不影响四个工具的可选增强；本测试故意不提供它。
      return name === 'skills' ? undefined : undefined
    },
    effect(fn) {
      return fn()
    },
    inject(names, callback) {
      assert.deepEqual(names, ['webServer'], '只等待 webServer 服务')
      const entry = {
        callback,
        live: false,
        stopped: false,
        effectDisposers: [],
        runCount: 0,
      }
      injections.push(entry)
      const stop = () => {
        entry.stopped = true
        deactivate(entry)
      }
      entry.stop = stop
      if (hasWebServer) activate(entry)
      return stop
    },
  }

  function deactivate(entry) {
    if (!entry.live) return
    entry.live = false
    for (const dispose of entry.effectDisposers.splice(0).reverse()) {
      if (typeof dispose === 'function') dispose()
    }
  }

  function activate(entry) {
    assert.equal(entry.live, false, '同一个注入回调不能并发激活两次')
    const webCtx = {
      ...ctx,
      webServer: currentWebServer,
      effect(fn) {
        const dispose = fn()
        if (typeof dispose === 'function') entry.effectDisposers.push(dispose)
        return dispose
      },
    }
    entry.live = true
    entry.runCount += 1
    entry.callback(webCtx)
  }

  function publish(webServer) {
    publishCount += 1
    currentWebServer = webServer
    if (hasWebServer) {
      for (const entry of injections) deactivate(entry)
    }
    hasWebServer = true
    for (const entry of injections) {
      if (entry.stopped || entry.live) continue
      activate(entry)
    }
  }

  function republishSame(webServer) {
    assert.equal(webServer, currentWebServer, '重复发布必须传同一个服务对象')
    publishCount += 1
  }

  return {
    ctx,
    tools,
    hooks,
    warnings,
    injections,
    publish,
    republishSame,
    get publishCount() {
      return publishCount
    },
  }
}

/** 造一个只记录响应内容的 HTTP response 桩。 */
function createResponse() {
  const res = {
    status: undefined,
    headers: undefined,
    body: undefined,
    endCalls: [],
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(body) {
      this.body = body
      this.endCalls.push(body)
      this.writableEnded = true
    },
  }
  return res
}

/** 造一个可手动发送 body 事件的 request 桩。 */
function createRequest({ method = 'GET', host = '127.0.0.1:43210', headers = {}, body, path = '/dsh-cost-router/state' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.headers = { host, ...headers }
  req.bodyFixture = body
  return req
}

async function request(route, options) {
  const req = createRequest(options)
  const res = createResponse()
  const pending = route.handler(req, res)
  if (options?.body !== undefined) req.emit('data', options.body)
  req.emit('end')
  await pending
  return res
}

function parseJson(res) {
  assert.equal(typeof res.body, 'string', 'JSON 响应应有响应体')
  return JSON.parse(res.body)
}

function createWebServer(routes) {
  let registrationCount = 0
  return {
    get registrationCount() {
      return registrationCount
    },
    register(route) {
      registrationCount += 1
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
}

const originalDshHome = process.env.DSH_HOME
const originalUserProfile = process.env.USERPROFILE
const originalHome = process.env.HOME
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-cost-router-webserver-'))

const restoreEnv = (name, value) => {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

try {
  // DSH_HOME 可写且独立，确保本测试不会碰用户真实 state.json。
  process.env.DSH_HOME = sandbox
  process.env.USERPROFILE = sandbox
  delete process.env.HOME

  const { apply } = await import('../lib/host.js')
  const host = createHost()

  // 启动时 webServer 尚未发布。四个工具和自动研判钩子仍必须完整注册。
  apply(host.ctx, { autoPlan: { enabled: true, minChars: 12 } })
  assert.deepEqual(
    host.tools.map((tool) => tool.name).sort(),
    ['cost_router_models', 'cost_router_plan', 'cost_router_report', 'cost_router_run'],
    '没有 webServer 时四个工具也必须全部注册',
  )
  assert.equal(host.hooks.length, 1, '自动研判钩子应注册一次')
  assert.equal(host.hooks[0].event, 'agent/pre-step')
  assert.equal(host.injections.length, 1, '应等待 webServer，但不能立即执行路由注册')
  assert.equal(host.injections[0].live, false, '服务缺席时注入回调应处于等待状态')
  assert.equal(host.injections[0].runCount, 0, '服务缺席时注入回调不应执行')
  assert.equal(host.warnings.length, 0)

  // webServer 晚发布后，延迟注入回调才执行并注册唯一状态路由。
  const routes = []
  const webServer = createWebServer(routes)
  host.publish(webServer)
  assert.equal(webServer.registrationCount, 1, '服务发布后应注册一次路由')
  assert.equal(host.injections[0].runCount, 1, '同一个注入回调应执行')
  assert.equal(routes.length, 1, '只应有一条状态路由')
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, '/dsh-cost-router/state')
  const stateRoute = routes[0]
  assert.equal(typeof host.warnings.length, 'number')

  // GET 返回实时状态；初始状态来自配置，尚无状态文件。
  const getRes = await request(routes[0], { method: 'GET' })
  assert.equal(getRes.status, 200)
  assert.match(getRes.headers['content-type'], /application\/json/)
  assert.equal(getRes.headers['cache-control'], 'no-store')
  assert.deepEqual(parseJson(getRes), { enabled: true, minChars: 12, auditEnabled: false, persisted: false })

  // HEAD 与 GET 同状态、同头部，但不能返回响应体。
  const headRes = await request(routes[0], { method: 'HEAD' })
  assert.equal(headRes.status, 200)
  assert.match(headRes.headers['content-type'], /application\/json/)
  assert.equal(headRes.body, undefined, 'HEAD 不应返回 JSON 响应体')

  // 同源 POST 同时更新开关与阈值，并同步落盘。
  const postRes = await request(routes[0], {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:43210', 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false, minChars: 20 }),
  })
  assert.equal(postRes.status, 200)
  assert.deepEqual(parseJson(postRes), { enabled: false, minChars: 20, auditEnabled: false, persisted: true })

  const stateFile = path.join(sandbox, 'dsh-cost-router', 'state.json')
  assert.deepEqual(
    JSON.parse(readFileSync(stateFile, 'utf8')),
    { autoPlanEnabled: false, autoPlanMinChars: 20, auditEnabled: false },
    'POST 后状态文件应立即更新为新格式',
  )

  // 再读一次应反映刚才持久化的值。
  const getAfterPost = await request(routes[0], { method: 'GET' })
  assert.deepEqual(parseJson(getAfterPost), { enabled: false, minChars: 20, auditEnabled: false, persisted: true })

  // 诊断接口只暴露脱敏排障字段，不返回任务正文、token 或凭据。
  const diagRes = await request(routes[0], { method: 'GET', path: '/dsh-cost-router/state?diagnostics=1' })
  assert.equal(diagRes.status, 200)
  const diagnostics = parseJson(diagRes)
  assert.equal(diagnostics.version, '0.5.0')
  assert.equal(diagnostics.stateRoute, '/dsh-cost-router/state')
  assert.equal(diagnostics.webServer, true)
  assert.deepEqual(diagnostics.tools, [
    'cost_router_plan', 'cost_router_run', 'cost_router_report', 'cost_router_models',
  ])
  assert.equal(diagnostics.autoPlan.enabled, false)
  assert.ok(Array.isArray(diagnostics.tools))
  // 护栏必须在诊断里可见：配置没给时也要有明确默认值，不能是 undefined，
  // 否则用户无法区分「没启用观察模式」和「这个字段根本没接线」。
  assert.deepEqual(diagnostics.guardrails, {
    dryRun: false,
    freeOnly: false,
    maxMultiplier: 10,
    defaultBudget: null,
  })
  assert.equal(JSON.stringify(diagnostics).includes('token'), false, '诊断信息不能含 token 字样')
  assert.equal(JSON.stringify(diagnostics).includes('task'), false, '诊断信息不能含任务正文')

  // 非法方法与跨站请求要被拒绝。
  const putRes = await request(routes[0], { method: 'PUT' })
  assert.equal(putRes.status, 405)
  const crossOrigin = await request(routes[0], {
    method: 'POST',
    headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(crossOrigin.status, 403)
  assert.deepEqual(parseJson(crossOrigin), { error: 'cross-origin' })

  // 4 KiB 上限按 UTF-8 字节计算：2 个中文字符占 6 字节，不能按 JS 字符串长度算。
  const multibyteRes = await request(routes[0], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ enabled: true, padding: '中'.repeat(1365) }), 'utf8'),
  })
  assert.equal(multibyteRes.status, 413, '多字节 UTF-8 请求超过 4096 字节应返回 413')
  assert.deepEqual(parseJson(multibyteRes), { error: 'request-body-too-large' })

  // 超大请求体必须明确返回 413，不能 destroy 后让 Promise 悬挂。
  const largeBodyRes = await request(routes[0], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{"enabled":true,"padding":"${'x'.repeat(5000)}"}`,
  })
  assert.equal(largeBodyRes.status, 413)
  assert.deepEqual(parseJson(largeBodyRes), { error: 'request-body-too-large' })
  assert.deepEqual(
    JSON.parse(readFileSync(stateFile, 'utf8')),
    { autoPlanEnabled: false, autoPlanMinChars: 20, auditEnabled: false },
    '被拒绝的超大请求不能改状态',
  )

  // 服务替换：旧服务的路由先清掉，同一个注入回调在新服务上重跑。
  const replacementServer = createWebServer(routes)
  host.publish(replacementServer)
  assert.equal(host.injections[0].runCount, 2, '服务替换应让原注入回调重跑')
  assert.equal(replacementServer.registrationCount, 1, '新服务应只收到一次路由注册')
  assert.equal(webServer.registrationCount, 1, '旧服务不应再次注册')
  assert.equal(routes.length, 1, '替换后旧路由应消失且只保留一条新路由')
  assert.notEqual(routes[0], stateRoute, '新服务应持有新注册的路由对象')
  const replacementGet = await request(routes[0], { method: 'GET' })
  assert.equal(replacementGet.status, 200)
  assert.deepEqual(parseJson(replacementGet), { enabled: false, minChars: 20, auditEnabled: false, persisted: true })

  // ── 审计开关必须是真开关 ────────────────────────────────────────────────
  // 0.4.x 出过「界面显示已开启、磁盘一个字节都没写」的假开关：开关值在构造时
  // 被固化，实时状态改了也没用。这里从 HTTP 接口一路验到落盘与诊断，任何一环
  // 断掉都会失败，而不是只测 PrivacyAudit 类内部。
  const auditOnRes = await request(routes[0], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false, auditEnabled: true }),
  })
  assert.equal(auditOnRes.status, 200)
  assert.equal(parseJson(auditOnRes).auditEnabled, true, 'POST 后应立刻回读为已开启')
  assert.equal(
    JSON.parse(readFileSync(stateFile, 'utf8')).auditEnabled,
    true,
    '审计开关必须落盘，重启后保持',
  )
  const diagAuditOn = parseJson(
    await request(routes[0], { method: 'GET', path: '/dsh-cost-router/state?diagnostics=1' }),
  )
  assert.equal(diagAuditOn.auditEnabled, true, '诊断接口必须反映实时审计开关')
  assert.deepEqual(diagAuditOn.priceSources, { declared: 0, heuristic: 0, unknown: 0 })

  // 非布尔审计开关要被拒绝，不能默默写成 truthy 字符串。
  const badAudit = await request(routes[0], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false, auditEnabled: 'yes' }),
  })
  assert.equal(badAudit.status, 400)
  assert.deepEqual(parseJson(badAudit), { error: 'auditEnabled must be a boolean' })

  // 关闭开关必须同样实时生效，且不影响已落盘的其它字段。
  const auditOffRes = await request(routes[0], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false, auditEnabled: false }),
  })
  assert.equal(parseJson(auditOffRes).auditEnabled, false)
  const auditStateFile = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(auditStateFile.auditEnabled, false)
  assert.equal(auditStateFile.autoPlanEnabled, false, '改审计开关不能顺带改自动研判')

  // 删除审计记录：文件不存在时也必须返回成功，界面才不会出现假失败。
  const clearRes = await request(routes[0], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false, clearAudit: true }),
  })
  assert.equal(clearRes.status, 200)
  assert.equal(parseJson(clearRes).auditCleared, true)

  // 删除失败必须是一次「无副作用」的失败：只返回 500，不改开关、不写状态文件。
  // 这里把审计文件替换成一个「路径指向目录」的占位：rmSync 删除目录会失败，
  // 且 existsSync 仍为 true；此前实现先写 liveState 再 clear()，于是「删除审计」
  // 按钮失败时会顺带把自动研判/审计开关改掉。
  const statePath = path.join(sandbox, 'dsh-cost-router', 'state.json')
  const auditPath = path.join(sandbox, 'dsh-cost-router', 'audit.jsonl')
  const stateBeforeFailedClear = readFileSync(statePath, 'utf8')
  const diagBeforeFailedClear = parseJson(await request(routes[0], { method: 'GET' }))
  mkdirSync(auditPath, { recursive: true })
  let failedClear
  try {
    failedClear = await request(routes[0], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, minChars: 33, auditEnabled: true, clearAudit: true }),
    })
  } finally {
    rmdirSync(auditPath)
  }
  assert.equal(failedClear.status, 500, '删除失败应返回 500')
  assert.deepEqual(parseJson(failedClear), { error: 'audit-clear-failed' })
  assert.deepEqual(
    parseJson(await request(routes[0], { method: 'GET' })),
    diagBeforeFailedClear,
    '删除失败后实时开关快照必须完全不变',
  )
  assert.equal(
    readFileSync(statePath, 'utf8'),
    stateBeforeFailedClear,
    '删除失败后不得改写状态文件',
  )

  // 同一服务没有重新发布时不能再次注册，避免重复路由。
  const beforeRepeat = host.publishCount
  host.republishSame(replacementServer)
  assert.equal(host.publishCount, beforeRepeat + 1)
  assert.equal(host.injections[0].runCount, 2, '同一服务重复发布不应重跑注入回调')
  assert.equal(replacementServer.registrationCount, 1, '同一服务重复发布不能重复注册')
  assert.equal(routes.length, 1, '同一服务重复发布后仍只能有一条路由')

  // 插件卸载时 disposer 必须执行，旧路由不能残留。
  const stopInjection = host.injections[0].stop
  assert.equal(typeof stopInjection, 'function')
  stopInjection()
  assert.equal(routes.length, 0, '卸载插件后应移除状态路由')
  assert.equal(host.injections[0].live, false)

  // 卸载后即便服务又被替换，也不能重新挂上路由。
  const afterUnloadServer = createWebServer(routes)
  host.publish(afterUnloadServer)
  assert.equal(host.injections[0].runCount, 2, '卸载后不应重跑注入回调')
  assert.equal(afterUnloadServer.registrationCount, 0, '卸载后新服务不应收到路由注册')
  assert.equal(routes.length, 0, '卸载后不能残留路由')
} finally {
  restoreEnv('DSH_HOME', originalDshHome)
  restoreEnv('USERPROFILE', originalUserProfile)
  restoreEnv('HOME', originalHome)
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    // 清理临时目录失败不应掩盖真正的断言失败。
  }
}

console.log('webServer 延迟注入生命周期测试通过')
