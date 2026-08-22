---
title: Eve 兼容性
description: 理解 Eveland 已验证的 Eve 版本窗口与 Fail-closed Policy。
---

在 Eve 发布稳定 Compatibility Contract 之前，Eveland 只支持通过完整兼容矩阵的 Minor Line，并显式变更该窗口。代码中的产品契约支持 `0.42.x` 与 `0.44.x`，验证版本为 `0.42.0` 与 `0.44.0`。Eve 0.41 及更早版本不再允许 Import、Build、Restart、Activation、Playground、Agent Gateway 或 Schedule Execution。

窗口是一组已验证的 Line，而非连续区间：Eve 0.43 在发布后四小时内即被 0.44 取代，因此被有意跳过（此前 0.40 与 0.41 同样被跳过）——声明 `0.43.x` 的项目会收到与其他不受支持版本相同的升级诊断。跳过是安全的，因为从 0.42.0 到 0.44.0 的所有 Wire Format（Message Stream、Manifest、Workflow 存储 Spec、捆绑的 Workflow SDK）逐字节相同。

UI 仅将最新支持线 `0.44.x` 标为绿色。Eve 0.42.x 保持可运行，不过会以红色显示并提醒升级；不受支持的版本同样显示为红色且继续阻断。

## 窗口基线

平台曾为更老 Eve 线保留的兼容路径已全部移除，以下能力是整个窗口的基线：

- Session 只按 ID 寻址。Continuation Token 已从平台中彻底消失：Token 列、基于 Token 的 Reset 翻译以及 `POST /eve/v1/session/reset` Token 路由都已删除。Clear、Compact 与 Reset 位于 `POST /eve/v1/session/:sessionId/{clear,compact,reset}`。
- `localDev()` 只看进程，在 `eve start` 下不放行任何请求；Eveland 上的 Agent 必须改用 `evelandIdentity()`、`httpBasic()` 或 OIDC。
- Channel 消息发送默认 `turnPolicy: "steer"`；Eveland 注入的 Scheduler Adapter 始终显式使用 `"queue"`，因此 Schedule 不会抢占用户正在等待的 Turn。
- 自定义 Sandbox Backend Handle 必须实现保留 Durable Session 的 `stop()`；Eveland 会用受管的 bwrap Backend（`@evelandhq/sandbox-bwrap`）替换 Agent 自带的 Backend。
- 受支持的构建只产出 Discovery Manifest v13；投影器不再接受 v12。
- Eve 的隐式默认 Model 是 `zai/glm-5.2`；请显式钉住 `model` 以控制 Provider、行为与成本。
- Durable 后台工作与 Invocation Channel 属于基线：远端子 Session 流经父 Agent 在 `GET /eve/v1/session/:parentSessionId/subagents/:callId/:childSessionId/stream` 跟随、`operationId` 幂等建 Session、`POST /eve/v1/task-input/:token` 回调，以及 `mcpChannel()` 的 Durable Agent 工具都运行在 Eveland 的 Durable Deployment Routing 边界上。由于每条受支持的线都支持这些 Route，Agent Gateway 不再维护按操作区分的 Eve 版本下限——窗口本身就是门禁。
- 前端 `stop()` 已不存在；取消是 Durable、由 Hook 持有的 `cancel()` 命令。Eveland 的 Playground 会等待它（包括第一条事件确定 Durable Turn 之前的窗口），并在 Settlement 完成前保持 Stream Attached。
- Workflow 运行在存储 Spec v6 上。平台为每个新构建注入 `@evelandhq/workflow-world@0.12.0`；`@workflow/world-postgres@5.0.0-beta.34` 只存在于历史 Release 中，从不为新构建选用。更老的 Spec v5 World 会在启动门禁处失败。共享 World 还通过 Snapshot 剥离、Block 打包、Checkpoint 与截止期驱动的 Retention 约束物理 Stream 存储。
- MCP Channel 默认 `/eve/v1/mcp` 且可声明其他 `route`；Eveland 的路径透明 Agent Gateway 会保留任一路径及对应的 OAuth Protected-resource Metadata Route。
- Extension 可以提供 Channel、Schedule 与带命名空间的 Subagent；其完整的平台调度与观察集成作为单独的兼容性跟进交付。
- `chatgpt()` 是稳定 API，由 Codex 负责认证——但 ChatGPT 订阅模型在设计上仅限本地：Eveland Deployment 内没有 Codex 登录，钉住 `chatgpt()` 的 Agent 可以部署成功但会在运行期失败。部署的 Agent 请使用 AI Gateway 或服务端认证的 Model。
- `glob` 与 `grep` 不在默认 Agent 工具集中；依赖它们的 Agent 必须在对应 Tool 文件导出 `defineGlobTool()` / `defineGrepTool()`。
- 子 Agent 可以在 `defineSandbox` 回调中返回 `parent.sandbox` 以共享发起调用的父 Agent 的活 Sandbox；这样的子 Agent 不能再声明受管 Workspace 或 Skill 资源，Eveland 的受管 Backend 替换照常作用于父定义。

**Eve 0.42 吸收了被跳过的 0.40 与 0.41。** 来自 0.40：`task_peek` 从实验性后台任务中移除——任务通知现在直接携带完成结果与失败，被指示去 Peek 的 Agent 需改为依赖通知本身；当结果已被更早的响应覆盖时，按条件投递的任务唤醒可以保持静默。捆绑的 Workflow SDK 新增可选的批量事件写入（`WORKFLOW_BATCH_TRANSITIONS`，默认开启）——平台注入的 World 保持单事件写入路径，运行行为不变。`eve info --json` 现在输出不含 CLI Banner 的合法 JSON。来自 0.41：新增一等的 Linq iMessage/SMS Channel——注意其受管 Vercel Connect 设置路径在 Eveland Deployment 内不可用（与 `chatgpt()` 同理，容器内没有 Vercel Connect 会话），请改用便携的 Partner API Token 路径。来自 0.42 本身：Channel 与 Session 的 `respond()` 只接受精确的响应字面量或经 `parseInputResponses()` 证明的值，Channel 本地元数据无法再泄漏进 Durable Session-inbox Payload；`task_sleep` 框架工具被移除——Task 模式的父 Agent 改为依赖生命周期通知，而非由模型节奏控制的等待。

**Eve 0.44 吸收了被跳过的 0.43。** 来自 0.43：Tool 可以声明 `execution: "background"` 并返回 `task.delegated()` 回执，后台执行器通过 `task.send({ kind: "complete" | "fail" | "cancel" })` 在进程内回报进度与任务终态；开启 `experimental.tasks` 时，本地与远端 Subagent 也走同一条后台工具路径。动态工具的 Approval、Execute 与 Output 回调现在可跨冷启动持久化——捕获了不可序列化值的回调会直接抛出可操作的错误，而不是在 Replay 时静默丢失。远端 Subagent 的每一轮续接都会转发调用者身份，因此在恢复持久化的远端 Session 前请先把两端 Deployment 都升级：只在建 Session 时接受转发的接收方会用 HTTP 400 拒绝这样的续接（父 Agent 保留子 Handle，升级接收方后可重试）。来自 0.44 本身：Eve 自身的 OpenTelemetry 导出默认只保留公开受众的会话——内置消息 Channel 会把对话分类为 `public`、`private` 或 `unknown`，而经由 HTTP 到达的 Session（Eveland 的 Playground 与 Agent Gateway）属于 `unknown`。Eveland 的 Observer 不受影响，因为它是注入的 Hook、自带导出管线；但自行声明了 `otel()` / `agentRuns()` / `otelIntegration()` 的 Agent 将在自己的后端看不到 Playground 与 Gateway 会话，除非设置 `otel({ tracePolicy: () => true })`；`recordInputs` / `recordOutputs` 已废弃，改用由 `redactSpanInputs()` / `redactSpanOutputs()` 组合而成的 `exportPolicy`。在 `eve dev` 下，本地 Trace Spool 现在默认记录 Prompt 与输出，除非设置 `EVE_TRACES_CONTENT=off`。

对当前最新线，Agent 项目应刷新 Lockfile 并重新部署，才能实际获得 `0.44.0`，即便 `^0.44.0` 这样的 Range 已经允许它。自定义 NDJSON 消费者必须忽略空行，且不得把后台任务回执当作终态。只有在两端 Deployment 都已升级、接收方能点名信任的 Forwarder 时，才开启 Remote Principal Forwarding。

npm 上出现新版本并不自动扩大窗口。新的 Minor 只有在 Changelog 与源码审阅加上完整兼容矩阵之后才会进入；移除旧 Minor 同样是显式的产品变更。

## 强制执行点

当依赖缺失、超出窗口或无法证明兼容时，Eveland 在以下环节 Fail Closed：

- Source Import 与 Preflight
- Build 与 Restart
- 冷激活
- Playground 流量
- 公开 Session 的 Create、Continue、Cancel 与 Stream
- 公开 Session Reset
- 到达所选 Deployment 的其余全部公开 Agent Gateway 请求，包括自定义 Channel Route 与 Webhook（休眠的窗口外 Deployment 直接回答 409，而不会被唤醒）
- Schedule Execution

诊断信息会请项目所有者升级，而不是猜测旧协议。在生产环境升级 Eve 或 Eveland 之前，请先阅读对应 Release Notes。
