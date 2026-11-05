# 离线测试说明

本目录的测试全部离线运行，不调用真实模型、不访问网络，也不读写用户真实的 `state.json`。

## 运行时与测试时用的 Node 版本不是一回事

- 插件运行时（`lib/*.js`）按 `package.json` 的 `engines` 支持 Node 20、22、24；CI 会在三个版本上都对全部 `lib/*.js` 做 `node --check`。
- `auto-plan.test.mjs`、`trust-contract.test.mjs`、`webserver-lifecycle.test.mjs` 用 `node:module` 的同步 `registerHooks()` 注入 DSH 模块桩。这个 API 从 **Node 22.15** 才提供，Node 20 会报错 `The requested module 'node:module' does not provide an export named 'registerHooks'`。
- 因此 CI 在 Node 20 上只执行不依赖模块桩的测试，Node 22、24 上执行全部测试，Node 24 额外跑 `npm test` 与离线评测集。
- 本机执行全量测试请用 Node >= 22.15，例如 `node -v` 显示 `v24.x`。

## 一键运行

```sh
npm test
```

`npm test` 会检查 `lib/`、`test/`、`scripts/` 下所有 JS/MJS 语法，运行 `test/*.test.mjs` 全部离线测试，再运行 `config/auto-plan-eval.json` 的评测集。评测集覆盖中英文短句、否定、指定模型、图片、长文、紧急任务与代码排查；准确率不是 100% 时命令会失败，不静默放过规则回退。

单独查看逐条评测结果：

```sh
node scripts/evaluate-auto-plan.mjs --json
```

## 手动全量

```sh
npm test
npm pack --dry-run
git diff --check
```

PowerShell：

```powershell
npm test
npm pack --dry-run
git diff --check
```