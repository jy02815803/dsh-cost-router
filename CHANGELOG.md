# Changelog

本项目遵循语义化版本。变更按版本倒序记录，详细背景见 `ROADMAP.md`。

## [Unreleased]

### Planned

- 0.6.0：质量、兼容矩阵、多语言规则与自动化评测。
- 1.0.0：稳定契约、迁移策略、贡献流程与公开 Release。

### Fixed

- CI 自 `0.4.2` 起从未真正跑过：`actions/setup-node` 的 `cache: npm` 要求仓库存在 lockfile，而本插件只有 `peerDependencies`、不提供 `package-lock.json`，导致 workflow 在依赖准备阶段就以「Dependencies lock file is not found」失败，后续的语法检查与单元测试根本没执行。现移除 npm 缓存（测试通过桩模块运行，无需 `npm install`），语法检查补齐 `lib/auto-plan.js`、`lib/catalog.js`、`lib/llm.js`、`lib/router.js`，并增加 `workflow_dispatch` 以便手动触发验证。CI 配置不进入 npm 包，因此不影响 `0.5.0` 的产物与已发布的 Release。

## [0.5.0] - 2026-11-05

### Added

- 决策卡片（`lib/explain.js`）：每次研判输出 `decision`、`confidence`、`reasons`、`warnings`，说明识别到几类能力、为什么拆或不拆、价格来自声明还是推断；输出只含元数据，不含任务正文与凭据。
- 成本报告新增 `estimate`，给出估算、实耗、`delta`、`ratio` 与质量档 `exact`/`good`/`fair`/`poor`/`estimate-unavailable`。
- 价格来源归类（`lib/pricing.js`）区分 `declared`（渠道声明倍率）、`heuristic`（按模型名推断免费）、`unknown`（默认口径），并在诊断接口与决策卡片中展示。
- 本地隐私审计（`lib/audit.js`）：可选、默认关闭，只写 `audit.jsonl` 白名单九字段（`ts`/`stage`/`kinds`/`decision`/`model`/`estimated`/`actual`/`quality`/`accepted`），不联网、不上传，可一键删除；审计写入失败绝不影响主流程。
- 配置新增 `auditEnabled`、`dryRun`、`defaultBudget`；`run` 未显式传 `budget` 时回落到 `defaultBudget`。
- 设置页新增「本地隐私审计」开关与「删除审计记录」按钮，免重启生效；「运行状态」卡片展示四个护栏的实际生效值。
- 新增 `test/explain-audit.test.mjs`，覆盖置信度、偏差分档、价格来源归类、审计默认关闭与白名单字段。

### Fixed

- **观察模式此前无法开启**：实现读 `config.dryRun`，但 `Config` schema 从未声明该字段，因此无论怎么配置都恒为 `false`。现已声明并完整接线到 `liveState` → `auto-plan` → 诊断 → 界面。
- 界面「隐私审计」开关此前只改显示不落库：`PrivacyAudit.enabled` 改为实时读取 `liveState.auditEnabled`，开关点下去立刻决定写不写文件。
- `run` 阶段不再对同一决策重复写两条审计记录（decision 与 outcome 各司其职）。
- 诊断接口的 `priceSources` 此前因接线硬编码空目录而恒显示 `0/0/0`，改为惰性读取最近一次研判使用的模型目录。
- 护栏字段缺失时界面回退到语义正确的 `guardrails.disabled` 文案，不再误用「自动研判已关闭」的提示。
- 删除审计记录失败时使用独立的 `audit.clearFailed` 文案，不再复用自动研判的报错信息；切换审计前先清空上一次的提示，避免「已删除」长期遮蔽真实状态。

### Changed

- `webserver-lifecycle.test.mjs` 增加 HTTP 级审计回归：开启后回读与落盘、非布尔值返回 400、关闭不影响 `autoPlanEnabled`、`clearAudit` 成功与失败路径，以及 `guardrails` 四字段的默认值断言。
- CI 的语法检查与单元测试矩阵纳入 `lib/audit.js`、`lib/explain.js`、`lib/pricing.js` 与 `test/explain-audit.test.mjs`。
- 版本号 `0.4.2.1` → `0.5.0`。

## [0.4.2.1] - 2026-11-04

### Fixed

- 诊断接口改为 `/dsh-cost-router/state?diagnostics=1`，兼容 DSH `exact` 路由只匹配原路径的行为。
- 设置页「成本路由」增加运行状态卡片，显示版本、配置来源、工具数、待执行方案与最近错误摘要。

## [0.4.2] - 2026-11-04

### Added

- `plan` 返回 `planId` 与完整目录快照；`run` 可复用已确认方案，不再重复分解。
- `run` 支持 `freeOnly` 与 `maxMultiplier`，每次模型调用前执行成本护栏检查。
- 自动研判支持当前轮消息判定与 `dryRun`，历史提示不再让后续任务永久失效。
- `/dsh-cost-router/state/diagnostics` 提供脱敏运行状态；`report` 支持 `scope` 与 `detail`。
- `0.4.2` 可信契约回归测试、CI 语法与测试矩阵。

### Fixed

- 用户确认的方案与执行方案不一致、预算只在阶段入口检查、跨轮自动研判去重错误。
- 分解结果增加类型、数量、空指令与依赖引用校验。

## [0.4.1] - 2026-11-04

### Fixed

- 修复 Host 插件早于 `webServer` 发布时开关状态接口永久未注册的问题。
- 路由生命周期交给注入作用域 `effect` 管理，服务替换或卸载时清理旧路由。
- 状态文件同时持久化 `autoPlanEnabled` 与 `autoPlanMinChars`，兼容 0.4.0 格式；改用原子写入。
- 补齐 HTTP 方法、同源、字段类型、请求体字节上限与异常收口；测试不再读写真实状态文件。

### Changed

- 版本升至 0.4.1；README 明确当前 DSH 的「设置 → 内置插件 → 成本路由」入口。

## [0.4.0] - 2026-11-03

### Added

- 设置页「成本路由」页签与「自动研判」开关，支持免重启即时生效。

### Fixed

- 补齐 `settings.plugins.tab` 所需的客户端依赖；修复 `minChars`、中止、跨 run 预算隔离与 `longdoc` 评分。

[Unreleased]: https://github.com/jy02815803/dsh-cost-router/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.5.0
[0.4.2.1]: https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.4.2.1
[0.4.2]: https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.4.2
[0.4.1]: https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.4.1
[0.4.0]: https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.4.0
