# Changelog

本项目遵循语义化版本。变更按版本倒序记录，详细背景见 `ROADMAP.md`。

## [Unreleased]

### Planned

- 0.5.0：决策卡片、成本偏差、隐私审计与高级护栏。
- 0.6.0：质量、兼容矩阵、多语言规则与自动化评测。
- 1.0.0：稳定契约、迁移策略、贡献流程与公开 Release。

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

[Unreleased]: https://github.com/jy02815803/dsh-cost-router/compare/v0.4.2.1...HEAD
[0.4.2.1]: https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.4.2.1
[0.4.2]: https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.4.2
[0.4.1]: https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.4.1
[0.4.0]: https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.4.0
