/**
 * cost-router 浏览器半身：设置页里的「成本路由」页签 + 「自动研判」开关。
 *
 * 与 Host 半身的约定：
 *   GET  /dsh-cost-router/state → { enabled, minChars, persisted }
 *   POST /dsh-cost-router/state ← { enabled, minChars? }
 *
 * 写完**立即生效**，不需要重启 Harness：Host 侧的钩子每次任务都读内存里的
 * 实时值（见 lib/auto-plan.js 的说明）。
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
    }

    // ── 组件 ────────────────────────────────────────────────────────────────

    /**
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
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-cost-router'
    exports.__test = { STATE_ROUTE, DIAGNOSTICS_ROUTE, NS, zh, en }

    return module.exports
  },
})
