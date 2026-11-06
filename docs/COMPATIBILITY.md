# DSH 版本兼容矩阵

这份文件是机器可读的兼容状态：[compatibility.json](compatibility.json)。`verified` 只表示在列出的环境里完成过实机验收，不代表对所有 DSH 发行版做兼容承诺。

| DSH 版本 | 系统 | Node | 插件版本 | 状态 | 验收时间 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| `0.2.1-rc.3` | Windows 11 | `24.21.0` | `0.5.0` | 已实机验收 | 2026-11-05 | Harness 正常重启；诊断接口返回 `0.5.0` 与四项护栏；设置页三张卡片可见；审计写盘/停写/删除闭环通过 |
| `0.2.1-rc.3` | Windows 11 | `24.21.0` | `0.6.0` | 已实机验收 | 2026-11-05 | Harness 正常重启；诊断接口返回 `0.6.0`、4 个工具与四项护栏；设置页三张卡片可见；审计写盘/停写/删除闭环通过 |
| `0.2.1-rc.3` | Windows 11 | `24.21.0` | `0.7.0` | 待发布前实机复核 | — | `npm test`、GitHub Actions Node 20/22/24 全绿；发布前需验证研判胶囊、方案面板、控制路由与 `manual` 模式 |
| `0.2.0-rc.1` | 未验证 | `20/22/24` | `>=0.5.0` | 预期兼容 | — | 仅由 `peerDependencies` 推断 |
| `0.1.7-rc.2` | 未验证 | `20/22/24` | `>=0.5.0` | 预期兼容 | — | 仅由 `peerDependencies` 推断；`settings.describe` 与设置页插槽可能不同 |

## 如何贡献一条兼容记录

请在 [Issues](https://github.com/jy02815803/dsh-cost-router/issues/new/choose) 的「兼容性反馈」里附：DSH 版本、操作系统、Node 版本、插件版本、安装方式、`/dsh-cost-router/state?diagnostics=1` 输出、设置页是否可见、工具是否注册。日志请先去掉 API key、token 与任务正文。

不要为了「让矩阵好看」把未实机的组合标成 `verified`；`expected` 是诚实状态。