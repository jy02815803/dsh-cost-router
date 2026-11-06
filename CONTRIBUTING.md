# 贡献指南

欢迎提交 bug、兼容性样本和改进建议。提交前请先阅读 `ROADMAP.md`，避免重复工作。

## 本地检查

全量检查需要 Node >= 22.15：部分测试使用 `registerHooks()` 注入 DSH 模块桩。插件运行时本身由 CI 在 Node 20 / 22 / 24 上分别做语法验证。详见 `test/README.md`。

```sh
npm test
npm pack --dry-run
```

`npm test` 由 `scripts/run-tests.mjs` 执行：先检查 `lib/`、`test/`、`scripts/` 下所有 JS/MJS 的语法，再逐个运行 `test/*.test.mjs`，最后运行 `scripts/evaluate-auto-plan.mjs`（20 条样本，含元问题）。CI 在 Node 20 上会跳过依赖 `registerHooks()` 的测试，Node 22/24 运行全量测试，Node 24 额外跑 `npm test`。

测试必须使用临时 `DSH_HOME`，不得改写用户真实状态文件；不要调用真实 `cost_router_run`，也不要提交 API key、token、模型目录中的密钥或任务正文。

## 变更要求

- 改动路由或成本口径时，补充离线 fixtures 和回归断言，说明「为什么更省」以及「误差来自哪里」。
- 改动 UI 时，说明对应 DSH 版本、插槽和实机验收结果；界面截图不能代替接口与状态文件检查。
- 改动自动研判时，更新评测样本，至少覆盖短句、否定、指定模型、图片和多轮消息。
- 改动公开配置时，写清默认值、兼容范围与迁移路径；旧状态文件必须能继续读取。
- 保持 `plan`、`run`、`report` 的口径一致：用户确认的方案必须就是执行的方案。

## 提交与发布

提交信息使用中文或英文均可，但请写清影响面。每个版本更新 `package.json`、测试版本断言、`CHANGELOG.md`、`README.md`，并执行 `npm pack`。Release 只由维护者用 GitHub OAuth/仓库凭据创建，禁止把凭据写入仓库。

## 报告问题

请附：DSH 版本、插件版本、操作系统、profile 类型、复现步骤、脱敏日志、诊断页输出。不要把 `token`、`apiKey`、账号密码或任务原文粘贴到公开 issue。
