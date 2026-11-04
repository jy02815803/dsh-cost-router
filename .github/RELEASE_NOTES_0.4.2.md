## dsh-cost-router 0.4.2

本版把「用户确认的方案就是执行的方案」做成可验证契约。

- `cost_router_plan` 返回 `planId`；`cost_router_run` 传入后复用同一份子任务、模型目录与成本护栏，不重复拆解。
- 方案签名、任务文本、护栏不一致或方案过期时明确拒绝，不静默重拆。
- 预算检查覆盖分解、子任务和汇总；`freeOnly`、`maxMultiplier` 在每次模型调用前拦截收费模型。
- 自动研判只分析当前轮用户消息，支持 `dryRun`，修复历史提示导致后续任务永久跳过的问题。
- 新增分解结果 schema 校验、脱敏诊断接口、`report` 的 `scope/detail` 参数。
- 新增 `ROADMAP.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md`、CI 与 issue 模板。

验证：四组离线测试、全部语法检查、`git diff --check`、`npm pack` 均通过；不调用真实付费模型。

安装：下载 `dsh-cost-router-0.4.2.tgz`，或使用仓库的 `v0.4.2` tag。DSH 本地安装后需正常重启 Harness；设置入口为「设置 → 内置插件 → 成本路由」。
