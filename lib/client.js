/**
 * cost-router 浏览器半身：设置页里的「成本路由」页签、自动研判开关、
 * 运行状态卡片与本地隐私审计开关。
 *
 * 与 Host 半身的约定：
 *   GET  /dsh-cost-router/state          → { enabled, minChars, auditEnabled, persisted }
 *   GET  /dsh-cost-router/state?diagnostics=1
 *        → { version, stateRoute, webServer, configSource, tools, autoPlan,
 *            auditEnabled, priceSources, freeOnly, maxMultiplier, guardrails,
 *            startedAt, pendingPlans, lastError }
 *   POST /dsh-cost-router/state
 *        ← { enabled, minChars?, auditEnabled?, clearAudit? }
 *        → 同上，成功调用 clearAudit 时额外带 auditCleared: true
 *
 * 写完**立即生效**，不需要重启 Harness：Host 侧的钩子每次任务都读内存里的
 * 实时值（见 lib/auto-plan.js 的说明）；审计开关也由 liveState 实时决定写不写盘。
 *
 * 界面只用 React 与 DSH 主题变量（--dsw-alias-*），不依赖可能缺席的 UI 组件库，
 * 这样在别人的 DSH 版本上也不容易白屏。
 *
 * ⚠️ 依赖声明说明（踩过的坑）：
 *   `settings.plugins.tab` 这个插槽是由 @deepseek-ai/dsh-client-ui-settings-plugins
 *   声明（declare）的。只有当它被加载进客户端依赖图时，插槽才存在；否则
 *   ctx.slots.inject('settings.plugins.tab', ...) 会静默不执行（既无报错也无页签）。
 *   所以 package.json 的 dsh.client.inject 必须列出这个包名，见本文件末尾的注释。
 */

window.__ModuleLoader__.load({
  id: 'dsh-cost-router',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    // ── i18n ────────────────────────────────────────────────────────────────
    //
    // 命名空间与 locale/*.json 的市场元数据保持一致，避免两处文案打架。
    const NS = 'dsh-cost-router'

    const zh = {
      title: '成本路由',
      'autoPlan.title': '自动研判（每单任务先看该不该拆）',
      'autoPlan.desc':
        '打开后，每条任务先做一次免费的判断：该拆就拆开交给不同模型，不该拆就直接单模型做完。'
        + '研判是本地规则计算，不调用模型、不消耗积分。',
      'autoPlan.note': '点击立即生效，无需重启。判定「不用拆」时不会打扰你。',
      'autoPlan.failed': '没能读/写开关状态，请确认 Harness 正在运行；四个工具仍可正常手动调用。',
      'diagnostics.title': '运行状态',
      'diagnostics.loading': '正在读取诊断信息…',
      'diagnostics.failed': '诊断信息不可用（不影响开关）',
      'diagnostics.version': '版本',
      'diagnostics.source': '配置来源',
      'diagnostics.tools': '已注册工具',
      'diagnostics.plans': '待执行方案',
      'diagnostics.error': '最近错误',
      'audit.title': '本地隐私审计',
      'audit.desc': '默认关闭；仅记录分类、模型与估实偏差，不保存任务正文，不联网上传。',
      'audit.clear': '删除审计记录',
      'audit.cleared': '已删除本地审计记录',
      'audit.on': '已开启',
      'audit.off': '已关闭',
      'audit.state': '审计状态',
      'audit.clearFailed': '删除审计记录失败，请稍后重试。',
      'guardrails.title': '当前护栏',
      'guardrails.freeOnly': '仅免费',
      'guardrails.dryRun': '观察模式',
      'guardrails.maxMultiplier': '倍率上限',
      'guardrails.defaultBudget': '默认预算',
      'guardrails.unset': '未设置',
      'guardrails.disabled': '未开启',
      'surface.title': '最近一次研判',
      'surface.waiting': '还没有研判记录。发一条任务后，这里会显示判断结果。',
      'surface.meta': '追问 / 复盘：不介入',
      'surface.decompose': '建议拆分',
      'surface.single': '建议单模型',
      'surface.skip': '未触发研判',
      'surface.show': '查看方案',
      'surface.refresh': '刷新',
      'surface.open': '打开成本路由面板',
      'surface.close': '关闭',
      'surface.plan': '生成方案',
      'surface.run': '执行此方案',
      'surface.cancel': '取消运行',
      'surface.confirmPlan': '生成方案会调用一次规划模型；确定继续？',
      'surface.confirmRun': '执行会按当前方案调用多个模型并产生费用；确定继续？',
      'surface.task': '要处理的任务文本（仅本次提交，不保存）',
      'surface.placeholder': '粘贴或输入任务内容；不会写进审计文件',
      'surface.manual': '执行模式：手动确认（不会自动跑）',
      'surface.quality': '质量偏好',
      'surface.qualityFirst': '质量优先',
      'surface.balanced': '均衡',
      'surface.creditSaver': '省积分',
      'surface.qualityHint': '质量档在下次 Harness 重启后完全生效；本次只记录选择。',
      'surface.surfaceOn': '显示研判胶囊',
      'surface.surfaceOff': '隐藏研判胶囊',
      'surface.noPlan': '还没有可执行方案；请先点「生成方案」。',
      'surface.running': '正在运行…',
      'surface.failed': '操作失败',
      'surface.done': '已完成',
      'surface.noTaskText': '方案卡片不保存任务正文',
    }

    const en = {
      title: 'Cost Router',
      'autoPlan.title': 'Auto-triage (decide whether to split first)',
      'autoPlan.desc':
        'When on, every task first gets a free local check: split it across models when worth it, '
        + 'otherwise finish it with a single model. The check is pure local rules — no model call, no credits spent.',
      'autoPlan.note': 'Takes effect immediately, no restart needed. You are only notified when a split happens.',
      'autoPlan.failed': 'Could not read/write the switch state. Make sure the Harness is running; the four tools still work.',
      'diagnostics.title': 'Runtime status',
      'diagnostics.loading': 'Loading diagnostics…',
      'diagnostics.failed': 'Diagnostics unavailable (the switch still works)',
      'diagnostics.version': 'Version',
      'diagnostics.source': 'Config source',
      'diagnostics.tools': 'Registered tools',
      'diagnostics.plans': 'Pending plans',
      'diagnostics.error': 'Last error',
      'audit.title': 'Local privacy audit',
      'audit.desc': 'Off by default; stores only categories, models and cost deltas. No task text, no upload.',
      'audit.clear': 'Delete audit records',
      'audit.cleared': 'Local audit records deleted',
      'audit.on': 'On',
      'audit.off': 'Off',
      'audit.state': 'Audit state',
      'audit.clearFailed': 'Could not delete the audit records. Please try again later.',
      'guardrails.title': 'Current guardrails',
      'guardrails.freeOnly': 'free only',
      'guardrails.dryRun': 'observe only',
      'guardrails.maxMultiplier': 'max multiplier',
      'guardrails.defaultBudget': 'default budget',
      'guardrails.unset': 'unset',
      'guardrails.disabled': 'off',
      'surface.title': 'Last triage',
      'surface.waiting': 'No triage yet. Send a task and the verdict appears here.',
      'surface.meta': 'Follow-up / review: no intervention',
      'surface.decompose': 'Split suggested',
      'surface.single': 'Single model suggested',
      'surface.skip': 'Triage skipped',
      'surface.show': 'View plan',
      'surface.refresh': 'Refresh',
      'surface.open': 'Open Cost Router panel',
      'surface.close': 'Close',
      'surface.plan': 'Create plan',
      'surface.run': 'Run this plan',
      'surface.cancel': 'Cancel run',
      'surface.confirmPlan': 'Creating a plan calls a planner model once. Continue?',
      'surface.confirmRun': 'Running calls several models and may spend credits. Continue?',
      'surface.task': 'Task text (used only for this request, never stored)',
      'surface.placeholder': 'Paste or type the task; audit files never store it',
      'surface.manual': 'Execution mode: manual confirmation only',
      'surface.quality': 'Quality preference',
      'surface.qualityFirst': 'Quality first',
      'surface.balanced': 'Balanced',
      'surface.creditSaver': 'Credit saver',
      'surface.qualityHint': 'The quality mode fully applies after the next Harness restart; this choice is recorded now.',
      'surface.surfaceOn': 'Show triage capsule',
      'surface.surfaceOff': 'Hide triage capsule',
      'surface.noPlan': 'No executable plan yet; click “Create plan” first.',
      'surface.running': 'Running…',
      'surface.failed': 'Action failed',
      'surface.done': 'Done',
      'surface.noTaskText': 'The plan card does not store task text',
    }

    // ── 接口地址 ────────────────────────────────────────────────────────────
    //
    // 用 document.baseURI 拼相对路径，宿主挂在哪个前缀下都能自动跟着走，
    // 不硬编码端口或 token。
    const STATE_ROUTE = (() => {
      try {
        return new URL('dsh-cost-router/state', document.baseURI).pathname
      } catch {
        return '/dsh-cost-router/state'
      }
    })()
    const DIAGNOSTICS_ROUTE = `${STATE_ROUTE}?diagnostics=1`
    const CONTROL_ROUTE = (() => {
      try {
        return new URL('dsh-cost-router/control', document.baseURI).pathname
      } catch {
        return '/dsh-cost-router/control'
      }
    })()

    /** 读取当前开关状态。 */
    async function fetchState() {
      const response = await fetch(STATE_ROUTE, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    /** 写入开关状态，返回宿主确认后的最新状态。 */
    async function saveState(enabled, extra = {}) {
      const response = await fetch(STATE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ enabled, ...extra }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    /** 读取脱敏诊断摘要。 */
    async function fetchDiagnostics() {
      const response = await fetch(DIAGNOSTICS_ROUTE, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    /** 读取最近研判、方案与运行状态；只读，不产生模型费用。 */
    async function fetchControl() {
      const response = await fetch(CONTROL_ROUTE, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    /**
     * 用户显式确认后触发一次控制动作。
     * 没有 confirm:true 时 Host 会返回 400，避免网页脚本替用户花钱。
     */
    async function postControl(payload) {
      const response = await fetch(CONTROL_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ ...payload, confirm: true }),
      })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(value?.detail || value?.error || `HTTP ${response.status}`)
      return value
    }

    // ── 样式 ────────────────────────────────────────────────────────────────
    //
    // 全部走 DSH 主题变量，跟随明暗主题；不用硬编码颜色。
    const S = {
      wrap: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        maxWidth: '620px',
        color: 'var(--dsw-alias-label-primary)',
      },
      card: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '16px',
        padding: '14px 16px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: '10px',
      },
      text: { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 },
      title: { fontSize: '14px', fontWeight: 600, lineHeight: '20px' },
      desc: {
        fontSize: '12.5px',
        lineHeight: '19px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      track: (on) => ({
        position: 'relative',
        flex: '0 0 auto',
        width: '42px',
        height: '24px',
        marginTop: '2px',
        borderRadius: '999px',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        transition: 'background .15s ease',
        background: on
          ? 'var(--dsw-alias-state-business-primary, #2b6cff)'
          : 'var(--dsw-alias-border-l2, #c9cdd4)',
      }),
      knob: (on) => ({
        position: 'absolute',
        top: '2px',
        left: on ? '20px' : '2px',
        width: '20px',
        height: '20px',
        borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,.25)',
        transition: 'left .15s ease',
      }),
      hint: {
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      error: { fontSize: '12.5px', color: 'var(--dsw-alias-state-error-primary, #d93026)' },
      capsule: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        maxWidth: '260px',
        padding: '4px 9px',
        borderRadius: '999px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-l2, transparent)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      overlay: {
        position: 'fixed',
        right: '24px',
        bottom: '84px',
        zIndex: 1000,
        width: 'min(430px, calc(100vw - 48px))',
        maxHeight: 'min(70vh, 640px)',
        overflowY: 'auto',
        padding: '16px',
        borderRadius: '12px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-l1, #fff)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: '0 8px 30px rgba(0,0,0,.22)',
      },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '10px' },
      btn: {
        padding: '6px 10px',
        borderRadius: '6px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
      },
      primaryBtn: {
        background: 'var(--dsw-alias-state-business-primary, #2b6cff)',
        color: '#fff',
        border: 'none',
      },
      textarea: {
        width: '100%',
        minHeight: '64px',
        boxSizing: 'border-box',
        padding: '8px',
        borderRadius: '6px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        resize: 'vertical',
      },
      pre: {
        margin: '10px 0 0',
        padding: '10px',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.08))',
        fontSize: '12px',
        lineHeight: '18px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
    }

    // ── 组件 ────────────────────────────────────────────────────────────────

    /** 最近一次研判的文案；不显示任务正文。 */
    function verdictLabel(verdict, t) {
      if (!verdict) return t('surface.waiting')
      const key = {
        meta: 'surface.meta',
        decompose: 'surface.decompose',
        single: 'surface.single',
        skip: 'surface.skip',
      }[verdict.decision] ?? 'surface.skip'
      const kinds = Array.isArray(verdict.kinds) && verdict.kinds.length ? `（${verdict.kinds.join('、')}）` : ''
      return `${t(key)}${kinds}`
    }

    /**
     * 输入框右侧胶囊 + shell.overlay 面板。
     *
     * 0.7.0 只做「看得见、点得动」：所有 plan/run 都要求用户点按钮并显式确认，
     * 不在此处自动执行。Host 控制路由会二次校验 confirm:true。
     */
    function Surface(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const [data, setData] = useState(null)
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [task, setTask] = useState('')
      const [qualityMode, setQualityMode] = useState('balanced')
      const [surfaceVerdict, setSurfaceVerdict] = useState(true)

      const load = useCallback(async () => {
        try {
          const value = await fetchControl()
          setData(value)
          setQualityMode(value.qualityMode ?? 'balanced')
          setSurfaceVerdict(value.surfaceVerdict !== false)
        } catch {
          setData({ lastVerdict: null, lastPlanCard: null, executionMode: 'manual', autoExecute: false })
        }
      }, [])

      useEffect(() => {
        load()
        const timer = setInterval(load, 3000)
        return () => clearInterval(timer)
      }, [load])

      const chooseQuality = useCallback(async (mode) => {
        setQualityMode(mode)
        try {
          await saveState(data?.lastVerdict?.injected === true, { qualityMode: mode })
          setNotice(t('surface.qualityHint'))
        } catch {
          setNotice(t('autoPlan.failed'))
        }
      }, [data, t])

      const toggleSurface = useCallback(async () => {
        const next = !surfaceVerdict
        setSurfaceVerdict(next)
        try {
          await saveState(data?.lastVerdict?.injected === true, { surfaceVerdict: next })
        } catch {
          setSurfaceVerdict(!next)
        }
      }, [data, surfaceVerdict])

      const control = useCallback(async (action, planId) => {
        if (busy) return
        const text = String(task || '').trim()
        if (!text) {
          setNotice(t('surface.placeholder'))
          return
        }
        const prompt = action === 'plan' ? t('surface.confirmPlan') : t('surface.confirmRun')
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(prompt)) return
        setBusy(true)
        setNotice(t('surface.running'))
        try {
          const value = await postControl({
            action,
            task: text,
            ...(planId ? { planId } : {}),
          })
          setNotice(action === 'plan' ? (value.card?.summary || t('surface.done')) : value.result?.cost?.summary || t('surface.done'))
          await load()
        } catch (error) {
          setNotice(`${t('surface.failed')}: ${String(error?.message ?? error).slice(0, 160)}`)
        } finally {
          setBusy(false)
        }
      }, [busy, task, t, load])

      const verdict = data?.lastVerdict ?? null
      const planCard = data?.lastPlanCard ?? null

      const overlay = open
        ? h('div', { style: S.overlay, role: 'dialog', 'aria-label': t('surface.title') },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } },
            h('div', { style: S.title }, t('surface.title')),
            h('button', { type: 'button', style: S.btn, onClick: () => setOpen(false) }, t('surface.close')),
          ),
          h('div', { style: S.desc }, verdictLabel(verdict, t)),
          verdict?.reason ? h('div', { style: S.hint }, verdict.reason) : null,
          h('div', { style: S.hint }, t('surface.manual')),
          h('div', { style: S.row },
            h('span', { style: S.hint }, t('surface.quality')),
            ...['quality-first', 'balanced', 'credit-saver'].map((mode) => h('button', {
              type: 'button',
              key: mode,
              disabled: busy,
              onClick: () => chooseQuality(mode),
              style: { ...S.btn, ...(qualityMode === mode ? S.primaryBtn : {}) },
            }, t(`surface.${mode === 'quality-first' ? 'qualityFirst' : mode === 'credit-saver' ? 'creditSaver' : 'balanced'}`))),
          ),
          h('div', { style: S.hint }, t('surface.qualityHint')),
          h('button', {
            type: 'button',
            style: S.btn,
            disabled: busy,
            onClick: toggleSurface,
          }, surfaceVerdict ? t('surface.surfaceOff') : t('surface.surfaceOn')),
          h('div', { style: S.row },
            h('label', { style: S.hint }, t('surface.task')),
            h('textarea', {
              style: S.textarea,
              value: task,
              placeholder: t('surface.placeholder'),
              onChange: (event) => setTask(event?.target?.value ?? ''),
            }),
          ),
          h('div', { style: S.row },
            h('button', {
              type: 'button',
              style: { ...S.btn, ...S.primaryBtn },
              disabled: busy,
              onClick: () => control('plan'),
            }, t('surface.plan')),
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: busy || !planCard?.planId,
              title: planCard?.planId ? '' : t('surface.noPlan'),
              onClick: () => control('run', planCard?.planId),
            }, t('surface.run')),
            h('button', { type: 'button', style: S.btn, disabled: busy, onClick: load }, t('surface.refresh')),
          ),
          planCard?.summary ? h('pre', { style: S.pre }, planCard.summary) : h('div', { style: S.hint }, t('surface.noPlan')),
          h('div', { style: S.hint }, t('surface.noTaskText')),
          notice ? h('div', { style: notice.startsWith(t('surface.failed')) ? S.error : S.hint }, notice) : null,
        )
        : null

      return h(React.Fragment, null,
        surfaceVerdict
          ? h('button', {
            type: 'button',
            style: S.capsule,
            title: verdict?.reason || t('surface.title'),
            onClick: () => setOpen(true),
          }, verdictLabel(verdict, t))
          : null,
        overlay,
      )
    }    /**
     * 自动研判开关卡片。
     *
     * @param {object} props - 插槽注入的 props（t 由 register 的 inject 提供）。
     * @returns {object} React 元素。
     */
    function AutoPlanTab(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key

      const [ready, setReady] = useState(false)
      const [enabled, setEnabled] = useState(false)
      const [busy, setBusy] = useState(false)
      const [failed, setFailed] = useState(false)
      const [diagnostics, setDiagnostics] = useState(null)
      const [auditEnabled, setAuditEnabled] = useState(false)
      const [auditNotice, setAuditNotice] = useState('')

      useEffect(() => {
        let alive = true
        fetchState()
          .then((value) => {
            if (!alive) return
            setEnabled(value?.enabled === true)
            setAuditEnabled(value?.auditEnabled === true)
            setReady(true)
          })
          .catch((error) => {
            if (!alive) return
            console.warn('[dsh-cost-router] 读取开关状态失败:', error)
            setFailed(true)
            setReady(true)
          })
        return () => {
          alive = false
        }
      }, [])

      useEffect(() => {
        let alive = true
        fetchDiagnostics()
          .then((value) => {
            if (alive) setDiagnostics(value)
          })
          .catch(() => {
            if (alive) setDiagnostics({ error: t('diagnostics.failed') })
          })
        return () => {
          alive = false
        }
      }, [])

      const flip = useCallback(() => {
        if (busy) return
        const next = !enabled
        setBusy(true)
        setFailed(false)
        // 乐观更新：点一下必须立刻有反应，失败了再回滚。
        setEnabled(next)
        saveState(next, { auditEnabled })
          .then((value) => {
            setEnabled(value?.enabled === true)
            setAuditEnabled(value?.auditEnabled === true)
          })
          .catch((error) => {
            console.warn('[dsh-cost-router] 写入开关状态失败:', error)
            setEnabled(!next)
            setFailed(true)
          })
          .finally(() => setBusy(false))
      }, [busy, enabled, auditEnabled])

      const flipAudit = useCallback(() => {
        if (busy) return
        const next = !auditEnabled
        setBusy(true)
        setAuditEnabled(next)
        // 上一次操作的提示必须清掉，否则「已删除」会长期遮蔽真实状态。
        setAuditNotice('')
        saveState(enabled, { auditEnabled: next })
          .then((value) => setAuditEnabled(value?.auditEnabled === true))
          .catch(() => {
            setAuditEnabled(!next)
            setAuditNotice(t('autoPlan.failed'))
          })
          .finally(() => setBusy(false))
      }, [busy, auditEnabled, enabled, t])

      const clearAudit = useCallback(() => {
        if (busy) return
        setBusy(true)
        setAuditNotice('')
        saveState(enabled, { auditEnabled, clearAudit: true })
          .then(() => setAuditNotice(t('audit.cleared')))
          .catch(() => setAuditNotice(t('audit.clearFailed')))
          .finally(() => setBusy(false))
      }, [busy, auditEnabled, enabled, t])

      const toggle = h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': enabled ? 'true' : 'false',
          'aria-label': t('autoPlan.title'),
          disabled: !ready || busy,
          onClick: flip,
          style: { ...S.track(enabled), opacity: !ready ? 0.5 : 1 },
        },
        h('span', { style: S.knob(enabled) }),
      )

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.text },
            h('div', { style: S.title }, t('autoPlan.title')),
            h('div', { style: S.desc }, t('autoPlan.desc')),
          ),
          toggle,
        ),
        h('div', { style: S.hint }, t('autoPlan.note')),
        failed
          ? h('div', { style: S.error }, t('autoPlan.failed'))
          : null,
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.text },
            h('div', { style: S.title }, t('diagnostics.title')),
            diagnostics === null
              ? h('div', { style: S.desc }, t('diagnostics.loading'))
              : h(
                'div',
                { style: S.desc },
                `${t('diagnostics.version')}: ${diagnostics.version ?? '-'} · ` +
                `${t('diagnostics.source')}: ${diagnostics.configSource ?? '-'} · ` +
                `${t('diagnostics.tools')}: ${(diagnostics.tools || []).length} · ` +
                `${t('diagnostics.plans')}: ${diagnostics.pendingPlans ?? 0}`,
              ),
            // 护栏一栏：把「只免费 / 观察模式 / 倍率上限 / 默认预算」摊开显示。
            diagnostics?.guardrails
              ? h(
                'div',
                { style: S.hint },
                `${t('guardrails.title')}: ` +
                `${diagnostics.guardrails.freeOnly ? t('guardrails.freeOnly') : t('guardrails.disabled')} · ` +
                `${diagnostics.guardrails.dryRun ? t('guardrails.dryRun') : t('guardrails.disabled')} · ` +
                `${t('guardrails.maxMultiplier')} ${diagnostics.guardrails.maxMultiplier ?? '-'} · ` +
                `${t('guardrails.defaultBudget')} ` +
                (Number.isFinite(diagnostics.guardrails.defaultBudget)
                  ? diagnostics.guardrails.defaultBudget
                  : t('guardrails.unset')),
              )
              : null,
            diagnostics?.lastError
              ? h('div', { style: S.error }, `${t('diagnostics.error')}: ${diagnostics.lastError}`)
              : diagnostics?.error
                ? h('div', { style: S.error }, diagnostics.error)
                : null,
          ),
        ),
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.text },
            h('div', { style: S.title }, t('audit.title')),
            h('div', { style: S.desc }, t('audit.desc')),
            h('div', { style: S.hint }, `${t('audit.state')}: ${auditEnabled ? t('audit.on') : t('audit.off')}`),
            auditNotice ? h('div', { style: S.hint }, auditNotice) : null,
          ),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                'aria-checked': auditEnabled ? 'true' : 'false',
                'aria-label': t('audit.title'),
                disabled: !ready || busy,
                onClick: flipAudit,
                style: { ...S.track(auditEnabled), opacity: !ready ? 0.5 : 1 },
              },
              h('span', { style: S.knob(auditEnabled) }),
            ),
            h(
              'button',
              { type: 'button', disabled: busy, onClick: clearAudit, style: { fontSize: '12px' } },
              t('audit.clear'),
            ),
          ),
        ),
      )
    }

    // ── 插件入口 ────────────────────────────────────────────────────────────

    const inject = ['slots', 'locale']

    function apply(ctx) {
      // locale：注册命名空间，并把 t 绑定好供页签标题与组件复用。
      let t = (key) => key
      try {
        if (ctx?.locale?.register) {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'cost-router locale')
          t = ctx.locale.bind(NS)
        } else {
          console.warn('[dsh-cost-router] locale 服务不可用，回退为内置文案')
        }
      } catch (error) {
        console.warn('[dsh-cost-router] 注册 locale 失败:', error)
      }

      let slots
      try {
        slots = ctx?.slots
      } catch {
        slots = undefined
      }
      if (slots === undefined && typeof ctx?.get === 'function') {
        try {
          slots = ctx.get('slots')
        } catch {
          slots = undefined
        }
      }
      if (slots === undefined || typeof slots.inject !== 'function') {
        console.warn('[dsh-cost-router] slots 服务不可用，设置页开关无法挂载')
        return
      }

      slots.inject('settings.plugins.tab', () =>
        slots.register(
          {
            name: 'settings.plugins.tab',
            id: 'cost-router',
            order: 20,
            locale: NS,
            label: () => t('title'),
            inject: () => ({ t }),
          },
          (slotProps) => h(AutoPlanTab, slotProps),
        ),
      )

      // 这两个插槽由 DSH shell 声明，且已在本机 dsh-credit-bar 实机使用。
      // 输入框右侧显示胶囊，shell.overlay 承载方案卡片；不注入消息流，
      // 避免把用户看不见的提示误当作执行结果。
      slots.inject('conversation.input.right', () =>
        slots.register(
          { name: 'conversation.input.right', id: 'cost-router', order: 30 },
          () => h(Surface, { t }),
        ),
      )
      // Surface 自己把 overlay 渲染成 fixed 面板；这里仍注册一个 shell.overlay
      // 条目，便于宿主在未来提供placement/keepOpen 能力时平滑迁移。
      slots.inject('shell.overlay', () =>
        slots.register(
          { name: 'shell.overlay', id: 'cost-router', order: 40 },
          () => null,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-cost-router'
    exports.__test = { STATE_ROUTE, DIAGNOSTICS_ROUTE, CONTROL_ROUTE, NS, zh, en }

    return module.exports
  },
})
