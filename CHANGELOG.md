# Changelog

本项目遵循语义化版本。变更按版本倒序记录，详细背景见 `ROADMAP.md`。

## [Unreleased]

### Planned

- 0.8.0：受控自动执行（`executionMode`、预算/调用数/超时护栏、进度事件、取消与失败策略），需先解决宿主无法在 `pre-step` 直接写最终回复的问题。
- 1.0.0：稳定契约、迁移策略、贡献流程与公开 Release。
- provider 级并发、超时、限流退避、失败升级与按 `contextWindow` 分层汇总。
- 更多 DSH 版本的实机兼容记录、脱敏目录 fixtures 与页面冒烟。

## [0.7.0] - 2026-11-06

### Added

- `lib/presentation.js`：生成不含任务正文的中文方案卡片，`cost_router_plan` 与工具输出都显示每块能力、模型、倍率和预估。
- `lib/control.js`：新增同源控制路由 `GET/POST /dsh-cost-router/control`。`plan / run / cancel` 必须由用户点击并带 `confirm: true`；`run` 必须复用 `planId`。执行模式固定 `manual`，`autoExecute=false`。
- 输入框右侧「最近一次研判」胶囊与 overlay 面板：用 DSH 已声明的 `conversation.input.right` / `shell.overlay` 插槽，显示最近判断、质量档、方案摘要和手动控制按钮。
- `lastVerdict` / `lastPlanCard` / `lastRunCard` 写入运行态并进入诊断；`?diagnostics=1` 新增 `lastVerdict`、`lastPlanCard`、`surfaceVerdict`、`qualityMode`、`executionMode`、`autoExecute`。
- `qualityMode` 三档：`quality-first / balanced / credit-saver`，默认 `balanced`；`quality-first` 在能力达标后优先能力与上下文，`balanced` / `credit-saver` 优先低倍率；视觉门槛永不降级。
- `surfaceVerdict` 开关可隐藏胶囊；状态文件新增字段但兼容旧格式。
- 评测集扩展为 20 条中英样本，新增 4 条追问/元问题；新增 `test/visibility-control.test.mjs`。

### Changed

- `classifyTurn()` 识别「追问上轮 / 元问题 / 指代前文」；`shouldAutoPlan()` 返回 `decision` 与 `language`。`meta` 只记录不注入，也不进入自动执行候选。
- 评测脚本统计「决策类型准确率」；`npm test` 现在跑 25 个语法检查、7 个离线测试和 1 个评测集，任一准确率不足 100% 即失败。
- README 重写产品原则：能力是门槛、质量是目标、成本是约束；明确自动研判只给提示，0.7.0 不自动执行。
- 版本 `0.6.0` → `0.7.0`。

### Fixed

- 追问「这一轮分别用了哪个模型」不再被判成「无明显特征」后注入「不用拆」提示。
- 静默失败：研判结果不再只藏在注入文本里，用户可从胶囊、设置页和诊断接口看到刚判了什么以及是否注入。
- 「调不调」不再只靠会话模型：面板按钮通过 Host 控制路由显式触发，Host 侧二次校验确认标志。

### Added

- `npm test` 一键运行：新增 `scripts/run-tests.mjs`，自动检查 `lib/`、`test/`、`scripts/` 下所有 JS/MJS 语法、逐个执行离线测试并运行离线评测集；`package.json.files` 纳入 `scripts/` 与 `docs/`。
- README 顶部加 CI / Release 徽章。

### Fixed

- README 安装段把 Release `.tgz` 写成唯一推荐；删除 `file:D:/DSharness/dsh-cost-router` 绝对目录命令，补上「Windows 绝对路径可能让 pnpm 拼错并清残 `node_modules`」的风险说明，把 `github:` 与源码目录安装降级为高级用法。
- `POST /dsh-cost-router/state` 带 `clearAudit: true` 时，此前先改 `liveState` 并写 `state.json` 才尝试删除审计文件；删除失败返回 500 后，用户只点了「删除审计记录」，两个开关却已被请求里的值改写。现改为先清空文件，成功才写状态，失败时完全无状态副作用；补 HTTP 级失败回归断言（实时快照与磁盘状态均不变）。
- CI 自 `0.4.2` 起从未真正跑过：`actions/setup-node` 的 `cache: npm` 要求仓库存在 lockfile，而本插件只有 `peerDependencies`、不提供 `package-lock.json`，导致 workflow 在依赖准备阶段就以「Dependencies lock file is not found」失败，后续的语法检查与单元测试根本没执行。现移除 npm 缓存（测试通过桩模块运行，无需 `npm install`），语法检查补齐 `lib/auto-plan.js`、`lib/catalog.js`、`lib/llm.js`、`lib/router.js`，并增加 `workflow_dispatch` 以便手动触发验证。
- CI 改为 Node 20 / 22 / 24 兼容矩阵：运行时语法在三个版本全量验证；`auto-plan.test.mjs`、`trust-contract.test.mjs`、`webserver-lifecycle.test.mjs` 使用 Node 22.15+ 才有的 `registerHooks()`，因此 Node 20 只运行不依赖该 API 的两个测试，Node 22 / 24 运行全部 5 个测试。`package.json` 的 `engines` 保持 `>=18.0.0`，测试版本要求写入 `README.md`、`CONTRIBUTING.md` 与新增的 `test/README.md`。
- CI 配置与测试说明不进入 npm 包，因此不影响 `0.5.0` 的产物与已发布的 Release。
- `lib/client.js` 文件头注释仍描述 0.4.x 的开关接口，漏掉 `auditEnabled`、`clearAudit` 与 `?diagnostics=1` 诊断字段；实机加载的脚本功能本身已是 0.5.0，但公开项目里的注释会误导贡献者，现补齐完整接口约定。仅注释修改，不改变运行时行为。

## [0.6.0] - 2026-11-05

### Added

- `config/auto-plan-eval.json`：16 条中英文离线评测样本，覆盖短句、否定、指定模型、图片、长文、紧急任务与代码排查；`scripts/evaluate-auto-plan.mjs` 输出触发判定、拆分建议、能力识别准确率，以及拆分误触发 / 漏触发。当前三项准确率均为 100%。
- `lib/rules.js`：中文与英文能力词、强模型措辞、动作词分离维护；`router.js` 按文本特征选规则集，英文任务不再依赖中文关键词。
- `validateSubtasks()` 导出，补齐重复 id、空指令、非法 `kind`、任务数量、悬空依赖与依赖环校验；新增 `test/quality-compat.test.mjs` 做离线回归。
- `docs/COMPATIBILITY.md` 与 `docs/compatibility.json`：机器可读的 DSH 兼容矩阵，明确区分 `verified`、`pending-real-machine` 与 `expected`，不把未实测版本写成已验证。
- `npm test` 串起 21 个语法检查、6 个离线测试和 1 个离线评测集；CI 在 Node 24 上额外跑评测集和 `npm test`。

### Changed

- README 当前版本、下载链接与测试说明更新到 `0.6.0`；测试版本断言从 `0.5.0` 升到 `0.6.0`。
- `ROADMAP.md` 的 0.6.0 项按实际完成度逐条标记；provider 并发/限流退避、脱敏目录 fixtures 与页面冒烟留到 1.0.0。
- `package.json` 版本 `0.5.0` → `0.6.0`。

### Fixed

- `clearAudit` 失败时不再产生状态副作用（见 `3ee0a09` 的维护提交）；README 不再推荐可能破坏 `node_modules` 的 Windows 绝对路径 `file:` 安装命令。

## [0.5.0] - 2026-11-05

> 维护说明：2026-11-05 发布后修复了此前一直未真正执行的 CI，并补充 Node 20/22/24 兼容矩阵、测试版本说明、`npm test` 与安装指引；后续还修了 `clearAudit` 失败时的状态副作用。功能代码在 `v0.5.0` 标签处已定稿，维护提交不升版本号；打包出的 tgz 内容会随维护文档变化，Release 附件已同步为当时 `main` 的产物。详见 `[Unreleased]`。

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

[Unreleased]: https://github.com/jy02815803/dsh-cost-router/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.7.0
[0.6.0]: https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.6.0
[0.5.0]: https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.5.0
[0.4.2.1]: https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.4.2.1
[0.4.2]: https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.4.2
[0.4.1]: https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.4.1
[0.4.0]: https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.4.0
