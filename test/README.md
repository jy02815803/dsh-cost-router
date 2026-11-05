# 离线测试说明

本目录的测试全部离线运行，不调用真实模型、不访问网络，也不读写用户真实的 `state.json`。

## 运行时与测试时用的 Node 版本不是一回事

- 插件运行时（`lib/*.js`）按 `package.json` 的 `engines` 支持 Node 20、22、24；CI 会在三个版本上都对全部 `lib/*.js` 做 `node --check`。
- `auto-plan.test.mjs`、`trust-contract.test.mjs`、`webserver-lifecycle.test.mjs` 用 `node:module` 的同步 `registerHooks()` 注入 DSH 模块桩。这个 API 从 **Node 22.15** 才提供，Node 20 会报错 `The requested module 'node:module' does not provide an export named 'registerHooks'`。
- 因此 CI 在 Node 20 上只执行 `smoke.test.mjs` 与 `explain-audit.test.mjs`（这两个不依赖模块桩），Node 22、24 上执行全部 5 个测试。
- 本机执行全量测试请用 Node >= 22.15，例如 `node -v` 显示 `v24.x`。

全量运行：

```sh
for f in lib/*.js test/*.test.mjs; do node --check "$f"; done
for f in test/*.test.mjs; do node "$f"; done
npm pack --dry-run
git diff --check
```

PowerShell：

```powershell
Get-ChildItem lib\*.js, test\*.test.mjs | ForEach-Object { node --check $_.FullName }
Get-ChildItem test\*.test.mjs | ForEach-Object { node $_.FullName }
npm pack --dry-run
git diff --check
```