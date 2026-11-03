/**
 * cost-router — 模型调用适配层。
 *
 * 把一次模型调用收敛到一处：组装消息、发流、拼文本、读 usage、算成本。
 *
 * 为什么不用"自己发 HTTP"：DSH 的 `ctx.llm` 已经把凭据、重试、模型目录、
 * 上下文窗口校验、多模态投影全管好了。自己发 HTTP 会把这些全部重造一遍，
 * 而且拿不到宿主配置好的免费渠道。
 *
 * @module dsh-cost-router/llm
 */

/** 一次调用返回的结果。 */
export class CallResult {
  /**
   * @param {string} text - the assistant's text output.
   * @param {object} usage - token usage from the terminal usage chunk.
   * @param {object} model - the catalog model that ran.
   * @param {number} durationMs - wall-clock duration.
   * @param {string|null} failure - failure code when the call did not succeed.
   */
  constructor(text, usage, model, durationMs, failure) {
    this.text = text
    this.usage = usage
    this.model = model
    this.durationMs = durationMs
    this.failure = failure ?? null
  }
}

/** 判断一个异常是否表示"被中止"。 */
function isAbortError(error) {
  if (!error || typeof error !== 'object') return false
  if (error.name === 'AbortError') return true
  const code = String(error.code ?? '')
  return code === 'ABORT_ERR' || code === 'ABORTED'
}

/** 造一个标准的 AbortError，用于把"流正常收尾但原因是 aborted"也归一成中止。 */
function makeAbortError(cause) {
  const error = new Error('模型调用被中止')
  error.name = 'AbortError'
  if (cause !== undefined) error.cause = cause
  return error
}

/**
 * 把任何看起来像中止的异常归一成 name === 'AbortError' 的标准异常。
 *
 * 上游（agent 循环 / 用户界面）是按 error.name 认中止的，而有的提供方只给
 * code: 'ABORT_ERR'。原样往上抛会被当成普通故障，于是「用户停止」被记成
 * 「模型失败」。
 *
 * @param {unknown} error - the original thrown value.
 * @returns {Error} an error whose name is 'AbortError'.
 */
function normalizeAbortError(error) {
  if (error?.name === 'AbortError') return error
  return makeAbortError(error)
}

/**
 * 收集一个流里的文本、usage 与结束原因。
 *
 * @param {AsyncIterable<object>} stream - the chunk stream.
 * @returns {Promise<{text: string, usage: object, finish: object|null}>} collected result.
 */
export async function collectStream(stream) {
  let text = ''
  let usage = { inputTokens: 0, outputTokens: 0 }
  let finish = null

  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
    } else if (chunk.type === 'usage') {
      usage = chunk.usage ?? usage
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  return { text, usage, finish }
}

/**
 * 调用一个模型并拿回文本与 token 用量。
 *
 * @param {object} ctx - Cordis context carrying the `llm` service.
 * @param {object} model - catalog model to call.
 * @param {Array<object>} messages - request messages (text and image blocks).
 * @param {object} [options] - call options.
 * @param {string} [options.system] - system prompt.
 * @param {number} [options.temperature] - sampling temperature.
 * @param {number} [options.maxTokens] - output cap.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @param {string} [options.jsonMode] - ignored; JSON is requested in the prompt.
 * @returns {Promise<CallResult>} the call result.
 */
export async function callModel(ctx, model, messages, options = {}) {
  const llm = ctx.get('llm')
  if (!llm) throw new Error('cost-router 需要 DSH 的 llm 服务（@deepseek-ai/dsh-llm），但它没有挂载。')

  const started = Date.now()
  const request = {
    provider: model.provider,
    model: model.model,
    messages,
    ...(options.system ? { system: options.system } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.signal ? { signal: options.signal } : {}),
  }

  let collected
  try {
    collected = await collectStream(llm.stream(request))
  } catch (error) {
    // 中止不是"调用失败"，而是用户主动停止。必须归一成标准 AbortError 再向上抛（上游按 error.name 识别中止）：
    // 如果在这里吞成 failure，编排层会把它当普通失败，继续跑剩下的子任务——
    // 用户点了"停止"，插件却还在花钱。
    if (isAbortError(error)) throw normalizeAbortError(error)
    return new CallResult(
      '',
      { inputTokens: 0, outputTokens: 0 },
      model,
      Date.now() - started,
      error?.code ?? error?.message ?? 'ERROR',
    )
  }

  // 流正常收尾但结束原因是 aborted，同样属于用户中止，向上抛。
  if (collected.finish?.kind === 'aborted') {
    throw makeAbortError()
  }

  const failure = collected.finish?.kind === 'error'
    ? collected.finish.failure?.code ?? 'ERROR'
    : null

  return new CallResult(collected.text, collected.usage, model, Date.now() - started, failure)
}

/**
 * 把一次调用换算成相对成本（以标准价为 1.0 的倍率单位）。
 *
 * @param {object} model - catalog model.
 * @param {object} usage - token usage.
 * @returns {number} relative cost units.
 */
export function usageCost(model, usage) {
  if (!model) return 0
  const input = usage?.inputTokens ?? 0
  const output = usage?.outputTokens ?? 0
  const relative = (input * 1 + output * 3) / 1000
  return Number((relative * (model.costMultiplier ?? 1)).toFixed(6))
}
