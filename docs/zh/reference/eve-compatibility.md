---
title: Eve 兼容性
description: 理解 Eveland 已验证的 Eve 版本窗口与 Fail-closed Policy。
---

在 Eve 发布稳定 Compatibility Contract 之前，Eveland 只支持通过完整兼容矩阵的 Minor Line，并显式变更该窗口。代码中的产品契约支持 `0.49.x`、`0.50.x` 与 `0.51.x`，验证版本为 `0.49.0`、`0.50.0` 与 `0.51.1`。Eve 0.48（2026-09-02 窗口滑到它之后即被 0.49.0 取代、被跳过，没有任何 Deployment 在其上运行过）以及 Eve 0.47 及更早版本不再允许 Import、Build、Restart、Activation、Playground、Agent Gateway 或 Schedule Execution。

项目 `package.json` 中允许的 Eve 依赖声明形式为：受支持线内的精确 Patch、锚定在受支持 Minor Patch 上的 `~`/`^` Range，以及 `0.49` / `0.49.x` / `0.49.*`、`0.50` / `0.50.x` / `0.50.*`、`0.51` / `0.51.x` / `0.51.*`。缺少 Eve 依赖、跨 Minor 的宽泛 Range 或任何可能解析到窗口之外的声明都会 Fail Closed。项目 Overview、Source 与 Playground 会显示当前 Deployment 对应 Source Revision 的 Eve 依赖版本与平台要求。

这是第一个三条线的窗口。`0.49.x` 是被保留而非淘汰：窗口决定的是导入的 Agent 可以声明什么，多留一条线只多一个矩阵条目，砍掉一条线却会让所有锁定它的项目搁浅。三条 Minor 全部相邻，因此其 Range 是一个连续区间，而不是带缺口窗口所需的多段并集。`0.48.x` 从未通过验证（0.49.0 在数小时内即将其取代，更早的 0.46、0.43 与 0.40/0.41 亦然），继续连同 `0.47.x` 及更早版本一起落在下限之下；`0.52.x` 在通过兼容矩阵之前也不会被接纳。

UI 仅将最新支持线 `0.51.x` 标为绿色。Eve 0.49.x 与 0.50.x 保持可运行，不过会以红色显示并提醒升级；不受支持的版本同样显示为红色且继续阻断。

## 窗口基线

平台曾为更老 Eve 线保留的兼容路径已全部移除，以下能力是整个窗口的基线：

- Session 只按 ID 寻址。Continuation Token 已从平台中彻底消失：Token 列、基于 Token 的 Reset 翻译以及 `POST /eve/v1/session/reset` Token 路由都已删除。Clear、Compact 与 Reset 位于 `POST /eve/v1/session/:sessionId/{clear,compact,reset}`。
- `localDev()` 只看进程，在 `eve start` 下不放行任何请求；Eveland 上的 Agent 必须改用 `evelandIdentity()`、`httpBasic()` 或 OIDC。
- Channel 消息发送默认 `turnPolicy: "steer"`；Eveland 注入的 Scheduler Adapter 始终显式使用 `"queue"`，因此 Schedule 不会抢占用户正在等待的 Turn。
- 自定义 Sandbox Backend Handle 必须实现保留 Durable Session 的 `stop()` 与 `delete()`——后者永久删除该 Sandbox 的一次性状态、保留共享的 Template 状态；Eveland 会用受管的 bwrap Backend（`@evelandhq/sandbox-bwrap`）替换 Agent 自带的 Backend，两者它都已实现。
- 受支持的构建产出 Discovery Manifest v15；投影器只接受它（仅 0.45.0 产出的 v14 已随 0.45 线一起离开窗口）。v15 携带可选的 `instrumentation` 模块引用与 `memories` 列表。
- Message Stream 协议是本窗口内**唯一**不统一的 Wire Format：`0.49.x` 说 v24，`0.50.x` 与 `0.51.x` 说 v25。每个响应都用 `x-eve-stream-version` 头声明版本，Eveland 的 Playground 与 Agent Gateway 原样转发它，而平台自身的客户端基于最新线构建，因此两种都能读。自定义 NDJSON 消费者必须同时处理两种形状：v24 的 Append 事件在 Delta 之外还带累积快照（`messageSoFar` / `reasoningSoFar`）与 UTF-16 的 `inputTextOffset`，v25 只带 Delta。
- Eve 的隐式默认 Model 在整个窗口内都是 `openai/gpt-5.6-luna-fast`（0.47.0 与 0.47.1 仍默认 `zai/glm-5.2`）；请显式钉住 `model` 以控制 Provider、行为与成本。
- Durable 后台工作与 Invocation Channel 属于基线：远端子 Session 流经父 Agent 在 `GET /eve/v1/session/:parentSessionId/subagents/:callId/:childSessionId/stream` 跟随、`operationId` 幂等建 Session、`POST /eve/v1/task-input/:token` 回调，以及 `mcpChannel()` 的 Durable Agent 工具都运行在 Eveland 的 Durable Deployment Routing 边界上。由于每条受支持的线都支持这些 Route，Agent Gateway 不再维护按操作区分的 Eve 版本下限——窗口本身就是门禁。
- 前端 `stop()` 已不存在；取消是 Durable、由 Hook 持有的 `cancel()` 命令。Eveland 的 Playground 会等待它（包括第一条事件确定 Durable Turn 之前的窗口），并在 Settlement 完成前保持 Stream Attached。
- Workflow 运行在存储 Spec v6 上；窗口内每条线的运行时都接受声明 6 或 7 的 World。平台为每个新构建注入 `@evelandhq/workflow-world@0.15.0`；`@workflow/world-postgres@5.0.0-beta.34` 只存在于历史 Release 中，从不为新构建选用。更老的 Spec v5 World 会在启动门禁处失败。共享 World 还通过 Snapshot 剥离、Block 打包、Checkpoint 与截止期驱动的 Retention 约束物理 Stream 存储。
- MCP Channel 默认 `/eve/v1/mcp` 且可声明其他 `route`；Eveland 的路径透明 Agent Gateway 会保留任一路径及对应的 OAuth Protected-resource Metadata Route。
- Extension 可以提供 Channel、Schedule 与带命名空间的 Subagent；其完整的平台调度与观察集成作为单独的兼容性跟进交付。
- `chatgpt()` 是稳定 API，由 Codex 负责认证——但 ChatGPT 订阅模型在设计上仅限本地：Eveland Deployment 内没有 Codex 登录，钉住 `chatgpt()` 的 Agent 可以部署成功但会在运行期失败。部署的 Agent 请使用 AI Gateway 或服务端认证的 Model。
- `glob` 与 `grep` 不在默认 Agent 工具集中；依赖它们的 Agent 必须在对应 Tool 文件从 `eve/tools/glob` / `eve/tools/grep` 再导出提供的定义（`defineGlobTool()` / `defineGrepTool()` 工厂已随 0.44 一起移出窗口）。
- 子 Agent 可以在 `defineSandbox` 回调中返回 `parent.sandbox` 以共享发起调用的父 Agent 的活 Sandbox；这样的子 Agent 不能再声明受管 Workspace 或 Skill 资源，Eveland 的受管 Backend 替换照常作用于父定义。

## 窗口内各版本支持情况

- **Eve 0.49.x（验证版本 `0.49.0`）**：采用 Message Stream v24 协议与 Sealed Log 存储模型（Spec 7），支持基本的不可变发布与沙箱隔离。
- **Eve 0.50.x（验证版本 `0.50.0`）**：Message Stream 升级至 **v25**（纯 Delta 增量流传输，移除累积快照），支持 Discovery Manifest v15 与动态能力重置。
- **Eve 0.51.x（推荐，验证版本 `0.51.1`）**：引入 Workflow Tool 与 Subagent 深度集成机制，强化持久化会话与动态扩展能力。

对当前最新线，Agent 项目应刷新 Lockfile 并重新部署，才能实际获得 `0.51.1`，即便 `^0.51.0` 这样的 Range 已经允许它。自定义 NDJSON 消费者必须忽略空行与未知事件类型，且不得把后台任务回执当作终态。只有在两端 Deployment 都已升级、接收方能点名信任的 Forwarder 时，才开启 Remote Principal Forwarding。

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
