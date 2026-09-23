---
title: Eve 兼容性
description: 理解 Eveland 已验证的 Eve 版本窗口与 Fail-closed Policy。
---

在 Eve 发布稳定 Compatibility Contract 之前，Eveland 只支持通过完整兼容矩阵的 Minor Line，并显式变更该窗口。代码中的产品契约支持 `0.62.x` 与 `0.64.x`，验证版本为 `0.62.0` 与 `0.64.1`。Eve 0.63（2026-09-23 被跳过：只要后台 Subagent 调用遇到订阅了 Subagent 事件的 Hook——Eveland 自己的 Observer 就是这样的 Hook——0.63.0 就会让该 Session 失败，而 0.64.0 在任何 Eveland 发布版带上 0.63 之前就发布了修复）、Eve 0.58（2026-09-23 随 0.64 进入而退出）、Eve 0.59、0.60 与 0.61（2026-09-19 被跳过：每一条都在一天之内被下一条取代，没有任何 Eveland 发布版带上过它们）、Eve 0.55（2026-09-19 随 0.62 进入而退出）、Eve 0.56 与 0.57（2026-09-17 被跳过：0.58.0 在任何 Eveland 发布版带上它们之前就已取代二者）、Eve 0.54（2026-09-16 随 0.56 进入一个本就是两条线的窗口而退出）、Eve 0.52 与 0.53（2026-09-15 同时退出）、Eve 0.50 与 0.51（2026-09-12 同时退出）、Eve 0.49（2026-09-07 退出）、Eve 0.48（2026-09-02 窗口滑到它之后即被 0.49.0 取代、被跳过，没有任何 Deployment 在其上运行过）以及 Eve 0.47 及更早版本不再允许 Import、Build、Restart、Activation、Playground、Agent Gateway 或 Schedule Execution。

项目 `package.json` 中允许的 Eve 依赖声明形式为：受支持线内的精确 Patch、锚定在受支持 Minor Patch 上的 `~`/`^` Range，以及 `0.62` / `0.62.x` / `0.62.*`、`0.64` / `0.64.x` / `0.64.*`。缺少 Eve 依赖、跨 Minor 的宽泛 Range 或任何可能解析到窗口之外的声明都会 Fail Closed。项目 Overview、Source 与 Playground 会显示当前 Deployment 对应 Source Revision 的 Eve 依赖版本与平台要求。

窗口是一组经过验证的线，而不是"下限以上的一切"：`0.64.x` 于 2026-09-23 进入，`0.63.x` 落在包络之内却从未通过验证——它唯一的版本 0.63.0 会让每个后台 Subagent 调用遇到订阅了 Subagent 事件或 `"*"` 的 Hook 的 Session 失败（Eveland 的 Observer 就是这样的 Hook），0.64.0 在三天后发布了修复；它会以与已退出的线相同的升级提示被拒绝。`0.58.x` 同日退出，`0.62.x` 因此成为下限（验证版本仍为 `0.62.0`），SDK 的 Peer 下限随之移到 `>=0.62.0`。Release 由已退出的线构建的 Deployment，从 Eveland 带上收窄后的窗口起就不再可服务：Agent Gateway 对它回答 409，Activation 拒绝它，平台会把仍停在它上面的 Workflow Run 直接结算，而不是继续重试；Eve 无法在另一个 Eve 版本下继续同一个 Session，因此重新构建只会开启新的 Session、无法接续旧的。`0.62.0` 与 `0.64.1` 之间的 Wire 面没有变化——Message Stream v25、Discovery Manifest v15、存储 Spec 7、路由集合，以及除 `taskRunWorkflow` 之外的不带版本戳的 Workflow 名（0.63 在移除后台 `defineTool` 时一并移除了它）——因此两条线的差别在于 Sandbox API 与后台工作（见下文 0.64.x 条目）和自带的 Workflow 版本组。窗口内每条线都能以 Delivery Id 确认消息，因此每个被接受的 Deployment 都能从 Playground 连上。Peer Range 是两个连续区间的并集（`>=0.62.0 <0.63.0 || >=0.64.0 <0.65.0`），而不是会把被跳过的线也放进来的包络。`0.59.x`、`0.60.x` 与 `0.61.x`（2026-09-19 被跳过），以及从未通过验证的 `0.48.x`（0.49.0 在数小时内即将其取代，更早的 0.46、0.43 与 0.40/0.41 亦然），继续连同 `0.58.x`、`0.57.x`、`0.56.x`、`0.55.x`、`0.54.x`、`0.53.x`、`0.52.x`、`0.51.x`、`0.50.x`、`0.49.x`、`0.47.x` 及更早版本一起落在下限之下；`0.65.x` 在通过兼容矩阵之前也不会被接纳。

UI 仅将最新支持线 `0.64.x` 标为绿色。Eve 0.62.x 保持可运行，不过会以红色显示并提醒升级；不受支持的版本同样显示为红色且继续阻断。

## 窗口基线

平台曾为更老 Eve 线保留的兼容路径已全部移除，以下能力是整个窗口的基线：

- Session 只按 ID 寻址。Continuation Token 已从平台中彻底消失：Token 列、基于 Token 的 Reset 翻译以及 `POST /eve/v1/session/reset` Token 路由都已删除。Clear、Compact 与 Reset 位于 `POST /eve/v1/session/:sessionId/{clear,compact,reset}`。
- `localDev()` 只看进程，在 `eve start` 下不放行任何请求；Eveland 上的 Agent 必须改用 `evelandIdentity()`、`httpBasic()` 或 OIDC。
- Channel 消息发送默认 `turnPolicy: "steer"`；Eveland 注入的 Scheduler Adapter 始终显式使用 `"queue"`，因此 Schedule 不会抢占用户正在等待的 Turn。
- 每个 Sandbox 在哪里运行由 Eveland 决定：它把受管的 bwrap Sandbox（`@evelandhq/sandbox-bwrap`）注入每个 Release，形态按 Release 所用 Eve 线能编译的来，并依据项目声明的 Eve 依赖选择。在 0.62.x 上，它生成一个 `defineSandbox({ backend })` 模块，用 bwrap Backend 替换 Agent 自带的 Backend，同时保留 Agent 编写的 `bootstrap()`、`onSession()`、`description` 与 `revalidationKey`。在 0.64.x 上，Sandbox 模块导出一个 Provider `environment` 和一个 `defineSandbox()` Selector；Eveland 保留 Agent 自己编写的模块，只把它的 `eve/sandbox` 导入重定向，让每个内置 Provider（`DefaultSandbox`、`DockerSandbox`、`VercelSandbox`、`MicrosandboxSandbox`、`JustBashSandbox`）都改为构建 bwrap Environment：Agent 编写的 `prepare` 与 Selector 照常运行，镜像、Dockerfile 等 Provider 专属选项被忽略；项目留空的 Sandbox 位置会得到一个生成的模块。在 0.64.x 上，`eve build` 会准备每个 Template 并记录准备它的 Provider；只要有任何 Sandbox 由其他 Provider 准备——在辅助文件里构建的 Environment、来自 `eve/sandbox/provider` 的自定义 Provider，或由 Extension 提供的 Sandbox——Eveland 就拒绝该 Release。
- 受支持的构建产出 Discovery Manifest v15；投影器只接受它（仅 0.45.0 产出的 v14 已随 0.45 线一起离开窗口）。v15 携带 `memories` 列表；0.62.0 在不再发现扁平的 `agent/instrumentation.ts` 时不再写入可选的 `instrumentation` 模块引用，且没有提升版本号，Eveland 也从未读取过该字段。
- Message Stream 协议在整个窗口内统一：每条受支持的线都说 **v25**，其 Append 事件只带 Delta（v24 的累积快照 `messageSoFar` / `reasoningSoFar` 与 UTF-16 的 `inputTextOffset` 已随 0.49 离开窗口）。每个响应仍用 `x-eve-stream-version` 头声明版本，Eveland 的 Playground 与 Agent Gateway 原样转发它；自定义 NDJSON 消费者应继续读取该头，而不是假定形状。两条线都带有 0.57 在 v25 之上加的那层可选、单独协商的传输租约：客户端用 `?streamControlVersion=1` 选择加入（`eve/client` 的读取器在启用重连且从绝对游标读取时都会这么做）后，会每 10 秒收到空行心跳，并在空闲 60 秒后收到一行 `{"$eve":"stream.lease-ended","version":1}` 控制帧结束响应，客户端随即从自己的游标重连。Agent Gateway 原样转发 Query String，并保留自己的 5 秒心跳。
- Eve 的隐式默认 Model 在 0.62.x 上是 `openai/gpt-5.6-luna-fast`，在 0.64.x 上是 `spacexai/grok-4.7`；请显式钉住 `model` 以控制 Provider、行为与成本。
- Durable 后台工作与 Invocation Channel 属于基线：远端子 Session 流经父 Agent 在 `GET /eve/v1/session/:parentSessionId/subagents/:callId/:childSessionId/stream` 跟随、`operationId` 幂等建 Session、`POST /eve/v1/task-input/:token` 回调，以及 `mcpChannel()` 的 Durable Agent 工具都运行在 Eveland 的 Durable Deployment Routing 边界上。由于每条受支持的线都支持这些 Route，Agent Gateway 不再维护按操作区分的 Eve 版本下限——窗口本身就是门禁。
- 前端 `stop()` 已不存在；取消是 Durable、由 Hook 持有的 `cancel()` 命令。Eveland 的 Playground 会等待它（包括第一条事件确定 Durable Turn 之前的窗口），并在 Settlement 完成前保持 Stream Attached。
- Workflow 运行在存储 Spec v7（Sealed Log）上：自 `@evelandhq/workflow-world` 0.18.0 起，World 声明 `mintedSpecVersion()`（默认 7，Deployment 设置 `WORKFLOW_SEALED_LOG=0` 时为 6），用 0.17.0 及更早版本构建的 Release 保留其 Spec 6 的运行，因为平台同时接纳两个世代。窗口内每条线的运行时都接受声明 6 或 7 的 World，并且只比较 World 所声明 `@workflow/*` 的 Major 与 Prerelease 标签（Eve 自带的 Bundle 在 0.61.0 移到 `5.0.0-beta.53/21/36/45`，0.62.0 带的就是它；0.64.0 又移到 `5.0.0-beta.55/22/37/46`，其中的 `@workflow/world` 新增了一个可选的 `invoke` 能力，Eveland 的 World 不声明它），因此同一个 World 能服务两条线。平台为每个新构建注入 `@evelandhq/workflow-world@0.22.0`，其 `@workflow/world` beta.37 与 `@workflow/world-local` beta.46 与 0.64.x 自带的版本一致；它还改用 Node 核心 HTTP 客户端投递被持有的 Dispatch，运行超过五分钟的 Step 不会再被全局 `fetch` 的 300 秒期限截断并重投，把跨 Deployment 的 `start()` 投递给它所指定的 Deployment 而不是发起入队的那个，并且（自 0.21.0 起）在同一个事务里提交一个 Run 及其 `run_created` 事件；`@workflow/world-postgres@5.0.0-beta.34` 只存在于历史 Release 中，从不为新构建选用。更老的 Spec v5 World 会在启动门禁处失败。共享 World 还通过 Snapshot 剥离、Block 打包、Checkpoint 与截止期驱动的 Retention 约束物理 Stream 存储。
- MCP Channel 默认 `/eve/v1/mcp` 且可声明其他 `route`；Eveland 的路径透明 Agent Gateway 会保留任一路径及对应的 OAuth Protected-resource Metadata Route。
- Durable Tool 用 `eve/tools` 的 `defineWorkflowTool` 声明，委托写法是 `ctx.agent(target, input)`——Eve 自行推导可重放的调用身份，内联的 `outputSchema` 决定返回类型；父 Turn 上的 Workflow Tool 经由一个有序 Inbox 处理、重试的 Dispatch 可能再开一个 Run，`defaultTools: false` 可让 Agent 跳过 Eve 的可选默认工具。`experimental.workflow.retention: 0` 与 `experimental.workflow.modelCallsPerStep` 在整个窗口内都是可选的 Agent 选项：Retention 偏好以保留属性 `$retention` 记录在 Run 上，Eveland 的共享 World 会存储但不执行它，而更大的 Step 批次会在中断后扩大重放单元。
- `task_update` 工具及其子到父的进度回调在整个窗口内都已不存在：改用子 Session 的 Stream 跟踪后台任务，并预期重叠的后台任务结果会跨 Launch Turn 一起到达父 Agent。
- OpenTelemetry Agent Trace Schema 在整个窗口内都是 4：每次 Activation 都是按 `gen_ai.conversation.id` 分组的 `invoke_agent` Span，模型输入只以 `gen_ai.input.messages` 记录一次，Memory 的 Recall/Capture 有自己的 Span 与 `memory.operation.*` Hook 事件。Eveland 的 Observer 与 Collector 映射不依赖任何 Schema 4 之前的名字，但基于 Agent 自己 `otel()` 导出搭建的 Dashboard 必须面向 Schema 4。
- `tool`、`dynamicTool`、`channel`、`connection`、`hook` 与 `state` 这几个 Extension 契约会随 Eve 的改造丢弃版本，而 0.64.x 会拒绝 0.62.x 构建产出的其中每一个：0.63 在移除后台 `defineTool` 与 `TaskExec`、并不再在任务视图中暴露 Executor 绑定时，丢弃了 `tool` 28、44–46 与 49–52，`dynamicTool` 28–30、41 与 48–50，以及 `channel` 23–26；0.64 在 Sandbox Session 不再暴露核心身份、可变网络改由 Provider 各自决定时，又丢弃了 `tool` 53、`dynamicTool` 51、`channel` 27–28、`connection` 23、`hook` 24 与 `state` 6。0.64.1 位于 `tool` 54、`dynamicTool` 52、`channel` 29、`schedule` 15、`subagent` 19、`connection` 24、`hook` 25、`dynamicSkill` 21、`dynamicInstructions` 22 与 `state` 7，仍会加载 0.62.x 构建产出的 `schedule`、`subagent`、`dynamicSkill` 与 `dynamicInstructions` 契约。因此预编译的 Extension 必须针对项目实际构建所用的线重建；Eveland 自行注入的 Extension 从源码编译，不受影响。Eve CLI 默认向 Vercel 上报使用情况，除非设置 `EVE_TELEMETRY_DISABLED`；Eveland 为其运行的每次 Build 与每个 Deployment 都设置了它。
- Extension 可以提供 Channel、Schedule 与带命名空间的 Subagent；其完整的平台调度与观察集成作为单独的兼容性跟进交付。
- `chatgpt()` 是稳定 API，由 Codex 负责认证——但 ChatGPT 订阅模型在设计上仅限本地：Eveland Deployment 内没有 Codex 登录，钉住 `chatgpt()` 的 Agent 可以部署成功但会在运行期失败。部署的 Agent 请使用 AI Gateway 或服务端认证的 Model。
- `glob` 与 `grep` 不在默认 Agent 工具集中；依赖它们的 Agent 必须在对应 Tool 文件从 `eve/tools/glob` / `eve/tools/grep` 再导出提供的定义（`defineGlobTool()` / `defineGrepTool()` 工厂已随 0.44 一起移出窗口）。
- 子 Agent 可以共享发起调用的父 Agent 的活 Sandbox——在 0.62.x 上从自己的 `defineSandbox` 回调返回 `parent.sandbox`，在 0.64.x 上导出 `defineParentSandbox()`；这样的子 Agent 不能再声明受管 Workspace 或 Skill 资源，Eveland 的平台 Sandbox 照常作用于父 Agent。

## 窗口内各版本支持情况

- **Eve 0.62.x（验证版本 `0.62.0`）**：Instrumentation 改为在 `agent/instrumentation/` 下按路径命名的文件编写。扁平的 `agent/instrumentation.ts` 不再被发现，`experimental.instrumentationProviders` 也已移除，因为 Instrumentation 发现始终开启：请把现有模块拆成 Lifecycle Instrumentation、每个 OpenTelemetry 目的地一个 `otelIntegration()` 文件，以及共享的 `otel()` 设置（Eve 随包附带对照表 `docs/guides/instrumentation/migration.md`）。已弃用的形态一并离开——Provider 拒绝 `capture`，改用 `tracePolicy`；目的地上的 `recordInputs` / `recordOutputs` 会在声明时直接抛错；`redactSpanInputs()`、`redactSpanOutputs()`、`content` 与 `composeSpanExportPolicies()` 被移除；`exportPolicy` 接受单个策略或一个有序数组，其 Span 与 Attribute 回调返回对象形式的决策（`{ emit }`、`{ redact, inputs, outputs }`、`{ replace, value }`）。默认值也变了：旧 API 不主动要求就不导出内容，而现在只要配置了 OpenTelemetry 目的地，development 环境与 `public` 对话就会记录内容。Eveland Deployment 始终是 `production`，因此只有 `public` Audience 受影响；要保持旧行为，请显式声明只导元数据的 `tracePolicy`。这些都不涉及 Eveland 自己的 Observer——它以 Hook 形式注入并保有私有的遥测运行时，平台的采集设置也没有变化。客户端可以在第一条消息之前先创建 Session（不带 Body 的 `POST /eve/v1/session`；TypeScript 客户端的 `prewarm`，React 绑定的 `prewarm: true`）；Agent Gateway 像转发其他创建请求一样转发它，Eveland 的 Playground 没有开启。当输入由 Eve 而非参与者产生时，`message.received` 会带 `kind: "execution.background_task"`，Eve 的默认 Reducer 不再把它渲染成用户消息。`eve/tools/agent-router` 的 `agentRouter()` 会在已声明的 Subagent 之间为任务选路——包括用 `tool: false` 或 `disableTool()` 对模型隐藏的那些——它以带版本戳的 `executeAgentRouterTool` Workflow 运行，`agent` 也因此成为保留的 Subagent 名；Workflow Step 一旦访问只属于 Workflow Body 的 `ctx.agents`、`ctx.agent()` 或 `ctx.ask()` 就会立即失败。`eve/models` 的 `auto` 与 `eve/ai` 的 `evaluate` 取代了 `autoModel` 与 `eve/experimental/evaluate`，Tool 审批可以用 `auto({ model, instructions, criteria })` 交给评估模型，Eval 套件改用 `t.session()` 与 `t.judge()`。动态 Tool 的 Schema 通过 Durable Schema Factory 重放，因此预编译的 Extension 或 Provider 包必须用当前编译器重建（`defineDurableSchema`）。每次模型调用前，生效的 Instructions 与 Tool Schema 都会计入上下文压缩。Eve 自带的 Workflow 版本组在 0.61.0 移动（见窗口基线），`@vercel/sandbox` 换成稳定的 3.3 SDK。Eve 允许带有可恢复 Subagent 的空闲 Session 迁到更新的 Deployment；这一 Handoff 在 Eveland 上仍不会触发，Agent Gateway 始终把每个 Session 路由到它绑定的 Deployment。
- **Eve 0.64.x（推荐，验证版本 `0.64.1`）**：Sandbox 改为 Provider Environment。Sandbox 模块导出一个由 Provider 构建的 `environment`（`eve/sandbox` 的 `DefaultSandbox.environment()`，或各自 `eve/sandbox/*` 入口的 `DockerSandbox`、`VercelSandbox`、`MicrosandboxSandbox` 与 `JustBashSandbox`）和一个打开它的 `defineSandbox()` Selector；对象形式的 `defineSandbox({ backend, bootstrap, onSession })`、`defaultBackend` 与 `revalidationKey` 都已移除。每个 Sandbox 都要继承的准备工作移到 Environment 的 `prepare` 里，由 `eve build` 在准备 Template 时运行一次——在 Eveland 上即构建时在 bwrap 中运行——而每个 Session 各自的准备工作移到 Selector 中 `open()` 之后。一种形态的模块在另一条线上无法编译，因此迁到 0.64 的项目要改写自己的 Sandbox 模块；对应的注入方式由 Eveland 自行选择（见窗口基线）。0.63 把持久化后台工作移到了 Workflow Tool 上：`defineTool({ execution: "background" })`、后台动态工具、`TaskExec` 与 `postMessage` 都已移除，改用 `defineWorkflowTool`，不带版本戳的 `taskRunWorkflow` Run 也随之消失，每组后台任务已完成、失败与取消的结果会在一份自动报告里送达父 Agent。后台 Subagent 调用现在只以该调用的 `action.result` 返回回执，`subagent.completed` 只在父 Agent 记下子 Agent 的实际结果之后触发一次；Eveland 的 Observer 会让该调用的 Span 从回执起一直保持打开，直到那时或子 Session 结束，因此子 Agent 的 Span 仍挂在它下面。消息发送接受 `taskDeliveryPolicy: "auto" | "cohort"`：Channel Session 默认 `"auto"`，可能提前汇报本身就有用的后台结果，Eve 自己的 Schedule 默认 `"cohort"`；Eveland 的 Scheduler 显式要求 `"cohort"`，因此 Eveland 的 Schedule 与 Eve 的汇报方式一致。`/eve/v1/info` 改用第 5 版应答，带有基于 Provider 的 Sandbox 字段，Eveland 不读取它们。隐式默认 Model 是 `spacexai/grok-4.7`。连续的 Deployment Handoff 现在会让 Session 留在原来的 Stream 上，但 Handoff 在 Eveland 上仍不会触发，而且由于 Session Checkpoint 版本变了，本来也没有 Session 能跨越 0.62→0.64 的边界。Eve 自带的 Workflow 版本组在 0.64.0 移动（见窗口基线）。对当前最新线，Agent 项目应刷新 Lockfile 并重新部署，才能实际获得 `0.64.1`。

npm 上出现新版本并不自动扩大窗口。新的 Minor 只有在 Changelog 与源码审阅加上完整兼容矩阵之后才会进入；移除旧 Minor 同样是显式的产品变更。

## 强制执行点

当依赖缺失、超出窗口或无法证明兼容时，Eveland 在以下环节 Fail Closed：

- Source Import 与 Preflight
- Build 与 Restart
- 冷激活（构建时装入窗口外 Eve 版本的 Release 在激活请求时即被终态拒绝：绑定它的 Workflow Run 只会被 Dead-letter 一次，而不是每次冷启动后反复重试）
- Playground 流量
- 公开 Session 的 Create、Continue、Cancel 与 Stream
- 公开 Session Reset
- 到达所选 Deployment 的其余全部公开 Agent Gateway 请求，包括自定义 Channel Route 与 Webhook（休眠的窗口外 Deployment 直接回答 409，而不会被唤醒）
- Schedule Execution

诊断信息会请项目所有者升级，而不是猜测旧协议。在生产环境升级 Eve 或 Eveland 之前，请先阅读对应 Release Notes。

## 深入参考

- [源码导入](/zh/docs/reference/source-import)：Preflight 校验与依赖扫描契约
- [部署第一个 Agent](/zh/docs/agents/first-deployment)：项目导入与构建入门
- [升级与回滚](/zh/docs/operations/upgrades)：平台升级与 Eve 依赖演进管理
- [Agent Gateway 不变量](/zh/docs/reference/design/gateway)：滑动的 Fail-closed 兼容窗口设计决策
