# dsh-cost-router：任务分解 + 多模型分派

用便宜/免费的模型做调度，把复杂任务拆开，看图、读长文、深度推理、写稿分别交给最合适的模型，最后统一汇总。

**核心主张：省钱靠的不是"选对模型"，而是"上下文隔离" + "能力匹配"。**

当前版本 **0.4.2.1**，变更见 `CHANGELOG.md` 与文末「版本变更」；长期路线见 `ROADMAP.md`。

---

## 自动研判开关（默认开启）

插件设置里有开关：**设置 → 内置插件 → 成本路由**（部分 DSH 版本显示为「设置 → 插件 → 成本路由」），一个「自动研判」的开关。**默认开启**。

**打开后**：每条任务在交给模型之前，先做一次**免费**的规则研判——

- 判定「该拆」→ 提示模型先调 `cost_router_plan`，把方案（拆几块、派给谁、大概花多少）告诉你，你确认后再执行。
- 判定「不用拆」→ 什么都不提示，直接单模型把活干完。你看到的体验和平时完全一样，不会被打扰。

**关闭后**：插件完全不介入，四个工具仍然可用，想用的时候手动调。

**点一下立刻生效，不需要重启 Harness。**

### 为什么研判不花钱

研判走的是 `lib/router.js` 里的纯规则：正则匹配动作词 + 能力分类打分，**不调用任何模型**，微秒级返回。开不开这个开关，成本都是零。

**真正花钱的是「拆开执行」那一步**，只有 `cost_router_run` 会调用模型并产生费用。开关只是决定「要不要先花 0 元看一眼该不该拆」。

### 一个已知限制

开关通过 `agent/pre-step` 钩子往消息里注入一条提示，这属于**强指令**而非硬约束——模型看到会照做，但技术上不能 100% 强制。要做到绝对强制就得让插件接管整个对话循环，那样又慢又脆，不值得。

### 开关状态存在哪

界面上的选择会写到 `<Harness home>/dsh-cost-router/state.json`。优先级是：
**状态文件 > 插件配置 > 内置默认（开启）**。

之所以不直接用插件配置存：配置是启动时读的，改配置要重启；而状态文件由钩子每次任务实时读取，才能做到点一下立刻生效。

### 还能从配置改

不想用界面时，`config/policy.json` 或 profile 里该插件的 `config` 也能设（改完要重启）：

```json
{ "autoPlan": { "enabled": true, "minChars": 12 } }
```

`minChars` 是最短触发长度，默认 12 字，避免「好的」「继续」这类短句也触发研判。

---

## 它解决什么问题

你有一堆模型：有的免费、有的便宜、有的贵；有的能看图、有的不能；有的上下文窗口长、有的短。

一个复杂任务（比如"看这五张扫描件提取表格，再写一份分析报告"）里，不同环节需要的能力完全不同。让旗舰模型全程干，贵；让便宜模型全程干，看图环节直接失能。

本插件做的事：**把这个任务拆开，每一块派给"能真干好它"的最便宜模型。**

---

## 和第一版的区别（重要）

第一版是 CodeBuddy/WorkBuddy 插件，自己发 HTTP、自己填三个平台的 API key。这一版改成 DSH 原生插件，差别在于：

| | 第一版 | 这一版 |
|---|---|---|
| 模型来源 | 自己填 deepseek / zhipu / openrouter 的 key | **复用 DSH 已配置的全部渠道**，含免费渠道 |
| 调用方式 | 自己发 HTTPS | `ctx.llm.stream`，重试/凭证/多模态全由宿主管 |
| 成本口径 | 手工填 priceIn / priceOut | 读渠道自己声明的 `creditMultiplier` |
| 视觉任务 | **拿不到图**（只发纯文本） | 复用会话里的图片附件，自动进视觉子任务 |
| SKILL 加载 | 包内 `skills/`，DSH 不扫 | `ctx.skills.register` 内嵌注册 |
| 工具形态 | MCP server（外挂进程） | 原生工具（`ctx.tools.register`） |

**最关键的修正**：第一版绕开了 DSH 的模型体系，用户得重新配一遍 key；这一版直接用你已经配好的渠道——包括那个 `creditMultiplier: 0` 的免费模型。

---

## 四个工具

| 工具 | 作用 | 花钱吗 |
|---|---|---|
| `cost_router_plan` | 研判 → 给出 `planId`、方案和预估成本 | 只有需要拆时才花一次分解费 |
| `cost_router_run` | 传 `planId` 复用已确认方案执行，返回成品和真实花费 | 花 |
| `cost_router_report` | 逐次调用明细、各模型花费、合计 | 不花 |
| `cost_router_models` | 列出可用模型：是否支持图片、上下文窗口、成本倍率 | 不花 |

典型用法：

```
用户：看这五张扫描件截图，提取表格数据，再写一份分析报告
  → cost_router_plan  → 「拆，3 块：识图(免费VL) / 推理(中档) / 写稿(中档)，预估 0.004，plan_…」
  → 用户确认
  → cost_router_run（planId=plan_…）→ 成品 + 「本次 5 次调用，合计 0.0031」
```

---

## 路由逻辑

### 1. 先研判该不该拆（纯规则，不花钱）

拆解不是免费的：付分解费、付汇总费、还有文风断裂风险。所以先判断：

- 视觉 + 文本同时出现 → **必须拆**（便宜模型看不见图）
- 三类以上不同能力 → **拆**
- 动作 ≥3 且两类能力 → **拆**
- 其他情况 → **不拆**，直接派给最合适的单一模型

### 2. 能力是门槛，成本是目标

每个子任务有一个能力维度（vision / reasoning / writing / coding / longdoc / bulk）和一个能力门槛（0-5）。

```
候选池 = 能力分 ≥ 门槛的模型
候选池按成本倍率升序 → 选第一个
```

倍率 `0` 就是免费。所以**只要免费模型能力够，就永远用免费的**；能力不够才升级到贵的。

### 3. 视觉门槛不可降

```json
"vision": 5
```

识图能力是断崖式的：4 分和 5 分的准确率差一个量级，不是差 20%。所以视觉类任务只用真正支持图片输入的模型（`inputModalities` 含 `image`），绝不为了省钱降级。

### 4. 汇总不走成本优先

汇总决定了最终交付质量。所以 `pickSynthesisModel` 按**能力 + 上下文窗口**选，最后才用成本做同分裁决。这是个真 bug 的修复：第一版 `synthesize()` 用 `pickModel('writing')` 按价格挑最便宜的，与 README 里"汇总模型得够强"的说法矛盾。

---

## 成本口径

**相对成本**，不是美元。

基准：标准价模型（倍率 1.0）跑 1000 token 输入 = 1.0 单位。

| 渠道声明 | 倍率 | 含义 |
|---|---|---|
| `creditMultiplier: 0` | 0 | 真免费 |
| `creditMultiplier: 0.29` | 0.29 | 折扣档 |
| `creditMultiplier: 3.31` | 3.31 | 溢价档 |
| 无此字段，名字含 `Free` | 0 | 按免费记 |
| 无此字段，其他 | 1 | 标准价（**绝不默认当免费**） |

为什么不用美元：各渠道计价单位不统一（积分/额度/订阅），硬换算成美元只会给出假精度。相对成本能准确回答"这次比全用旗舰省了多少"。

---

## 调参

全在 `config/policy.json`，不用动代码。

| 症状 | 改法 |
|---|---|
| 某类子任务老派给贵模型 | 调低 `floors[kind]` |
| 某类子任务质量不行 | 调高 `floors[kind]`，或在 `capabilityOverrides` 给某个模型加分 |
| 想省钱优先于质量 | 所有 `floors` 统一减 1（**vision 那条不要动**） |
| 想只看某个渠道 | `onlyProviders: ["workbuddy"]` |
| 想固定汇总模型 | `synthesisModel: "Hy3"`（写 id 或显示名都行） |

---

## 文件

```
dsh-cost-router/
├── package.json          # dsh.bundle.patch + dsh.client.inject + locale/icon 导出
├── cordis.patch.yml      # 一行 loader 挂载
├── icon.svg
├── LICENSE               # MIT
├── .gitignore
├── README.md
├── locale/{en,zh}.json   # 插件市场里的标题与描述
├── config/policy.json    # 路由策略（能力门槛、覆盖、渠道限制）
├── skills/cost-router/SKILL.md   # 内嵌技能，告诉模型何时用这套流程
├── lib/
│   ├── host.js           # 插件入口：注册四个工具 + 内嵌技能
│   ├── client.js         # 浏览器半身：设置页「成本路由」页签与开关
│   ├── state.js          # 开关状态读写（state.json）
│   ├── auto-plan.js      # 自动研判提示注入（agent/pre-step）
│   ├── catalog.js        # 从 ctx.llm 读模型目录；从 settings 读成本倍率
│   ├── router.js         # 分类、异构判定、能力匹配、成本估算
│   ├── llm.js            # 统一的模型调用与 usage 采集
│   └── orchestrator.js   # plan / run / report 三个动作
│   ├── plan-store.js     # 已确认方案的进程内存储
│   └── runtime.js        # 工具实例间共享的运行时状态
└── test/
    ├── smoke.test.mjs        # 主流程冒烟测试
    ├── auto-plan.test.mjs    # 自动研判开关与状态持久化测试
    └── webserver-lifecycle.test.mjs  # 开关接口启动竞态与生命周期测试
    └── trust-contract.test.mjs       # 可信契约与自动研判回归测试
```

---

## 安装

### 推荐给测试者：下载 Release 包

打开 [Releases 页面](https://github.com/jy02815803/dsh-cost-router/releases)，下载最新版的 `dsh-cost-router-<版本>.tgz`。当前稳定版本为 [v0.4.2](https://github.com/jy02815803/dsh-cost-router/releases/tag/v0.4.2)，直接下载地址：

```text
https://github.com/jy02815803/dsh-cost-router/releases/download/v0.4.2/dsh-cost-router-0.4.2.tgz
```

在 DSH Desktop 的「插件」页选择本地包/本地目录安装，或把包解压后通过 profile 的 `file:` 依赖安装。**安装完成后必须正常重启 Harness**；客户端依赖图只在启动时组装，只刷新页面不生效。开源协作也可 fork、提 Issue 或 Pull Request。

### 方式一：从 GitHub 安装

```sh
dsh plugin --profile web add github:jy02815803/dsh-cost-router
```

### 方式二：从本地目录安装

```sh
dsh plugin --profile web add file:D:/DSharness/dsh-cost-router
```

或在 DSH Desktop 的「插件」页选择本地目录安装。

### 装完确认

1. 打开 **设置 → 内置插件**（部分 DSH 版本为 **设置 → 插件**），应该能看到 **成本路由** 页签，里面有「自动研判」开关。
2. 在对话里调 `cost_router_models`，应该列出你所有渠道的模型，标出哪些免费。
3. 拿一个多模态任务调 `cost_router_plan`，应该返回「拆」和方案。

> 如果第 1 步看不到页签，先确认 Harness 已重启——客户端依赖图只在启动时组装，只刷新页面不生效。

### 测试反馈

欢迎通过 [Issues](https://github.com/jy02815803/dsh-cost-router/issues/new/choose) 反馈；Bug 选「Bug 报告」，不同 DSH/系统组合选「兼容性反馈」。请附上版本号、DSH 版本、操作系统、安装方式、复现步骤、期望/实际结果，以及去掉 API key、token 和任务正文后的日志。测试时优先用 `cost_router_plan`、`cost_router_models` 等不产生费用的工具，不要公开真实凭据或敏感内容；安全漏洞请走 [Security Advisories](https://github.com/jy02815803/dsh-cost-router/security/advisories/new)。

---

## 测试

```sh
node test/smoke.test.mjs
node test/auto-plan.test.mjs
node test/webserver-lifecycle.test.mjs
node test/trust-contract.test.mjs
```

`smoke.test.mjs` 覆盖：任务分类、异构判定、成本口径（含"负倍率不能当免费"）、settings 目录抽取、路由策略（免费优先 / 视觉门槛 / 强制强模型 / 显式 pin）、端到端编排、失败隔离、多模态通道（图片只进视觉子任务）、预算熔断、分解结果非法 JSON、中止向上抛、`longdoc` 能力评分、多次 run 预算隔离、客户端 inject 清单。

`auto-plan.test.mjs` 覆盖：文本抽取、短文本不触发、`minChars` 配置读取、liveState 实时开关、去重、状态优先级、旧格式兼容、原子写入与不可写目录降级。

`webserver-lifecycle.test.mjs` 覆盖：无 `webServer` 时四个工具仍注册、服务晚发布、GET/HEAD/POST、同源校验、请求体上限、服务替换、重复发布与插件卸载。全部在隔离的临时 `DSH_HOME` 中运行。

`trust-contract.test.mjs` 覆盖：`planId` 方案复用、目录快照、成本护栏、逐步预算、跨轮自动研判和 `dryRun`。

---

## 已知边界

- **相对成本不是账单**。它衡量的是"相对贵贱"，不是"花了多少钱"。要看真实金额，用 DSH 自己的用量页。
- **图片来自当前会话**。`cost_router_run` 会取会话里最近最多 8 张图片，只送进 `vision` 类子任务。如果任务是"分析 D 盘里的图"，那图不在会话里，得先让模型读进来。
- **分解质量决定一切**。分解是整个流程里最吃脑子的活，所以 planner 强制用强模型（`forceStrong`），不看成本。分解错了，后面所有子任务都在错误方向上努力。
- **汇总后建议人工通读**。多个模型各写一段拼起来，长文仍可能口径不一。
- **子任务失败不阻断整体**。单个子任务失败会被标记，下游照跑（带"上游失败"提示），汇总能识别缺口。这是 `Promise.allSettled` 的修复：第一版用 `Promise.all`，一个失败整批全挂。

---

## 版本变更

### 0.4.2

**让「确认的方案就是执行的方案」成为硬契约。** `plan` 现在返回 `planId`，`run` 传入后复用同一份子任务、模型目录与成本护栏，不再重新分解；任务、护栏或方案签名不一致时明确拒绝。预算检查推进到分解、子任务、汇总的每次调用前，`freeOnly` 与 `maxMultiplier` 会拦截收费模型。

- 自动研判改为只分析当前轮用户消息，并支持 `dryRun`；上一轮注入的提示不再让后续任务永久失效。
- 分解结果增加任务类型、数量、空指令与依赖引用校验。
- 状态接口新增 `/dsh-cost-router/state/diagnostics` 脱敏诊断；`cost_router_report` 支持 `scope` 与 `detail`。
- 新增 `ROADMAP.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md`、CI 和 issue 模板。
- 版本号 `0.4.1` → `0.4.2`。

### 0.4.1

**修好了界面开关拿不到状态、点击后不生效的根因。** 0.4.0 在 apply 阶段一次性读取 `webServer`；Host 插件通常早于 Web 服务加载，因此这次读取会得到 `undefined`，接口路由永久没有注册，设置页开关就没有可用的数据源。

- 改用 `ctx.inject(['webServer'], ...)` 等待服务发布；服务被替换时同一个回调会重新运行。
- 路由 disposer 交给注入作用域的 `ctx.effect()` 管理，替换或卸载时清理旧路由，避免重复注册。
- GET、HEAD、POST 的状态接口补齐异常收口、字段校验、同源校验与按 UTF-8 字节计算的 4 KiB 请求体上限；超大请求会明确返回 `413` 而不会切断连接。
- 状态文件同时保存 `autoPlanEnabled` 与 `autoPlanMinChars`，兼容 0.4.0 旧格式；写盘改为临时文件加原子替换，候选目录用真实写入探测，失败时降级为当前进程内生效。
- 测试全部隔离到临时 `DSH_HOME`，运行测试不会改写用户真实的开关状态。
- 版本号 `0.4.0` → `0.4.1`。

### 0.4.0

**修好了「设置页看不到成本路由页签」**（也就是启动开关不显示的问题）。

根因：DSH 客户端插件要往设置页加页签，必须先声明依赖 `@deepseek-ai/dsh-client-ui-settings-plugins`。这个包负责声明 `settings.plugins.tab` 插槽。原版本的 `dsh.client.inject` 没列它，导致该包不进客户端依赖图；插槽没被声明时 `slots.inject()` 是**静默跳过**的——不报错、不打日志，页签就这么消失了。修复方式是在 `package.json` 的 `dsh.client.inject` 补上该包名。

> 注意：改动依赖图后必须**重启 Harness**，只刷新页面不够。

其它修复与改进：

- `minChars` 配置不再失效。原来只读扁平字段，`autoPlan.minChars` 写法被忽略。
- 用户点「停止」后不再继续烧钱。中止错误原来被吞成 `failure='ABORTED'`，剩余子任务照跑；现在向上抛出。
- 多次 `run` 之间预算与累计成本不再串台。原来 `totalCost` / `budgetCap` 跨 run 共享。
- `longdoc` 能力评分不再走死代码。`KIND_TO_CAPABILITY.longdoc` 原来误映射到 `reasoning`，导致长文分支永不命中。
- 静默失败全部补上日志：`collectSessionImages`、webServer 缺失、客户端各 catch 分支。
- 补齐 `LICENSE`（MIT）、`.gitignore`、`publishConfig`、`engines`、`repository`/`homepage`/`bugs`。
- 版本号 `0.3.0` → `0.4.0`。

---

## 发布到 GitHub

1. `package.json` 里的仓库地址已填好（`repository` / `homepage` / `bugs` 均为 `jy02815803/dsh-cost-router`）；如果你 fork 到自己账号下发布，改成你的用户名即可。
2. 在仓库根目录执行：

```sh
git init
git add .
git commit -m "dsh-cost-router 0.4.2"
git branch -M main
git remote add origin https://github.com/jy02815803/dsh-cost-router.git
git push -u origin main
```

3. 如果同时想发 npm：`npm publish`（`publishConfig.access` 已设为 `public`）。

---

## License

MIT，见 [LICENSE](./LICENSE)。
