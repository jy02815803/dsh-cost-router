/**
 * 0.7.0 可见性层：把 plan 结果整理成不含任务正文的中文方案卡片。
 *
 * 这里不做路由决策、不调用模型，只把 Orchestrator 已选好的模型与能力证据
 * 摊开给用户看。输出可以安全地进诊断接口、设置页和输入框右侧胶囊。
 *
 * @module dsh-cost-router/presentation
 */

const KIND_LABELS = {
  vision: '视觉',
  code: '代码',
  longdoc: '长文档',
  reasoning: '推理',
  writing: '写作',
  text: '文本',
  bulk: '批量',
  single: '单模型',
}

/** 能力标签中文化；未知 kind 原样保留，避免显示成 undefined。 */
export function kindLabel(kind) {
  return KIND_LABELS[kind] ?? String(kind ?? '未知')
}

/**
 * 把目录里的模型整理成「为什么能用」的元数据证据。
 *
 * @param {object|null} model - model catalog entry.
 * @returns {object} sanitized capability evidence.
 */
function modelEvidence(model) {
  if (!model || typeof model !== 'object') {
    return { id: '(无可用模型)', name: '', costMultiplier: null, free: false, reasons: [] }
  }
  const reasons = []
  if (model.supportsImage) reasons.push('支持图片输入')
  if ((model.contextWindow ?? 0) >= 200000) reasons.push('上下文窗口 ≥ 200K')
  else if ((model.contextWindow ?? 0) >= 100000) reasons.push('上下文窗口 ≥ 100K')
  if (Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0) reasons.push('支持推理档位')
  if (model.costMultiplier === 0 || model.free === true) reasons.push('渠道标记免费')
  reasons.push(`成本倍率 ${model.costMultiplier ?? 1}`)
  return {
    id: `${model.provider ?? '?'}/${model.model ?? '?'}`,
    name: String(model.name ?? '').slice(0, 80),
    costMultiplier: Number.isFinite(Number(model.costMultiplier)) ? Number(model.costMultiplier) : null,
    free: model.costMultiplier === 0 || model.free === true,
    reasons,
  }
}

/**
 * 生成一个不含任务正文、模型输出和凭据的方案卡片。
 *
 * @param {object} plan - Orchestrator.plan() result.
 * @param {object} [options] - presentation options.
 * @param {'quality-first'|'balanced'|'credit-saver'} [options.qualityMode] - routing preference.
 * @returns {object} display card.
 */
export function planCard(plan, options = {}) {
  const mode = plan?.mode === 'decomposed' ? 'decomposed' : 'single'
  const rows = Array.isArray(plan?.subtasks) ? plan.subtasks : []
  const assignments = mode === 'decomposed'
    ? rows.slice(0, 12).map((row) => ({
      id: String(row.id ?? '').slice(0, 32),
      kind: String(row.kind ?? '').slice(0, 32),
      kindLabel: kindLabel(row.kind),
      model: String(row.model ?? '').slice(0, 120),
      costMultiplier: Number.isFinite(Number(row.costMultiplier)) ? Number(row.costMultiplier) : null,
      free: row.free === true,
      dependsOn: String(row.depends_on ?? '').slice(0, 64),
      // instruction 可能含任务正文；卡片只显示长度作为脱敏证据。
      instructionChars: String(row.instruction ?? '').length,
    }))
    : [{
      id: 'single',
      kind: String(plan?.detectedKinds?.[0] ?? 'single'),
      kindLabel: kindLabel(plan?.detectedKinds?.[0] ?? 'single'),
      model: String(plan?.model ?? '').slice(0, 120),
      costMultiplier: Number.isFinite(Number(plan?.costMultiplier)) ? Number(plan?.costMultiplier) : null,
      free: plan?.free === true,
      dependsOn: '-',
      instructionChars: 0,
    }]

  const lines = [
    mode === 'decomposed' ? `建议拆分 ${assignments.length} 块` : '建议单模型直接完成',
    ...assignments.map((a) => `${a.kindLabel} → ${a.model}（倍率 ${a.costMultiplier ?? '?'}）`),
    `预估相对成本 ${Number(plan?.estCost ?? 0).toFixed(6)}`,
  ]

  return {
    version: 1,
    at: new Date().toISOString(),
    planId: String(plan?.planId ?? ''),
    mode,
    qualityMode: options.qualityMode ?? 'balanced',
    reason: String(plan?.reason ?? '').slice(0, 200),
    decision: plan?.decision ?? null,
    detectedKinds: Array.isArray(plan?.detectedKinds) ? plan.detectedKinds.slice(0, 12) : [],
    assignments,
    synthesisModel: plan?.synthesisModel ? String(plan.synthesisModel).slice(0, 120) : null,
    estCost: Number(plan?.estCost ?? 0),
    warning: plan?.warning ? String(plan.warning).slice(0, 200) : null,
    summary: lines.join('\n'),
    hasTaskText: false,
  }
}

/**
 * 给方案补上候选模型的能力证据；只使用目录元数据，不含凭据。
 *
 * @param {object} plan - Orchestrator.plan() result.
 * @param {object} catalog - catalog snapshot.
 * @returns {object} evidence summary.
 */
export function planEvidence(plan, catalog) {
  const card = planCard(plan)
  const models = Array.isArray(catalog?.models) ? catalog.models : []
  const find = (id) => models.find((m) => `${m.provider}/${m.model}` === id)
  return {
    assignments: card.assignments.map((a) => ({ ...a, evidence: modelEvidence(find(a.model)) })),
    synthesis: card.synthesisModel ? modelEvidence(find(card.synthesisModel)) : null,
  }
}

/** 把工具输出渲染成人能读的中文文本，供 defineTool.output.render 使用。 */
export function renderPlanText(value) {
  const card = value?.card ?? planCard(value)
  return [
    `【成本路由方案】${card.mode === 'decomposed' ? '建议拆分' : '建议单模型'}`,
    card.reason,
    ...card.assignments.map((a) => `- ${a.kindLabel}：${a.model}（倍率 ${a.costMultiplier ?? '?'}）`),
    `预估相对成本：${card.estCost.toFixed(6)}`,
    card.planId ? `planId：${card.planId}` : '',
    card.warning ? `提示：${card.warning}` : '',
  ].filter(Boolean).join('\n')
}