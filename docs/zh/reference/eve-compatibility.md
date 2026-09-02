---
title: Eve 兼容性
description: 理解 Eveland 已验证的 Eve 版本窗口与 Fail-closed Policy。
---

在 Eve 发布稳定 Compatibility Contract 之前，Eveland 只支持通过完整兼容矩阵的 Minor Line，并显式变更该窗口。代码中的产品契约支持 `0.47.x` 与 `0.48.x`，验证版本为 `0.47.7` 与 `0.48.0`。Eve 0.46 及更早版本——包括 2026-09-02 离开窗口的 0.45——不再允许 Import、Build、Restart、Activation、Playground、Agent Gateway 或 Schedule Execution。

项目 `package.json` 中允许的 Eve 依赖声明形式为：受支持线内的精确 Patch、锚定在受支持 Minor Patch 上的 `~`/`^` Range，以及 `0.47` / `0.47.x` / `0.47.*`、`0.48` / `0.48.x` / `0.48.*`。缺少 Eve 依赖、跨 Minor 的宽泛 Range 或任何可能解析到窗口之外的声明都会 Fail Closed。项目 Overview、Source 与 Playground 会显示当前 Deployment 对应 Source Revision 的 Eve 依赖版本与平台要求。

窗口是一组已验证的 Line，而非"下限以上皆可"：上一窗口内曾受支持的 `0.45.x` 在移出窗口的那一刻起，就会收到同样的升级诊断；`0.49.x` 在通过兼容矩阵之前也不会被接纳。当前这一对恰好相邻；此前的窗口曾带缺口（0.46 在发布后数小时内即被 0.47 取代而被跳过，更早的 0.40/0.41 与 0.43 亦然），带缺口的窗口会拒绝落在凸包内的被跳过线。

UI 仅将最新支持线 `0.48.x` 标为绿色。Eve 0.47.x 保持可运行，不过会以红色显示并提醒升级；不受支持的版本同样显示为红色且继续阻断。

## 窗口基线

平台曾为更老 Eve 线保留的兼容路径已全部移除，以下能力是整个窗口的基线：

- Session 只按 ID 寻址。Continuation Token 已从平台中彻底消失：Token 列、基于 Token 的 Reset 翻译以及 `POST /eve/v1/session/reset` Token 路由都已删除。Clear、Compact 与 Reset 位于 `POST /eve/v1/session/:sessionId/{clear,compact,reset}`。
- `localDev()` 只看进程，在 `eve start` 下不放行任何请求；Eveland 上的 Agent 必须改用 `evelandIdentity()`、`httpBasic()` 或 OIDC。
- Channel 消息发送默认 `turnPolicy: "steer"`；Eveland 注入的 Scheduler Adapter 始终显式使用 `"queue"`，因此 Schedule 不会抢占用户正在等待的 Turn。
- 自定义 Sandbox Backend Handle 必须实现保留 Durable Session 的 `stop()` 与 `delete()`——后者永久删除该 Sandbox 的一次性状态、保留共享的 Template 状态；Eveland 会用受管的 bwrap Backend（`@evelandhq/sandbox-bwrap`）替换 Agent 自带的 Backend，两者它都已实现。
- 受支持的构建产出 Discovery Manifest v15；投影器只接受它（仅 0.45.0 产出的 v14 已随 0.45 线一起离开窗口）。v15 携带可选的 `instrumentation` 模块引用与 `memories` 列表。
- Eve 的隐式默认 Model 在整个窗口内都是 `openai/gpt-5.6-luna-fast`（0.47.0 与 0.47.1 仍默认 `zai/glm-5.2`）；请显式钉住 `model` 以控制 Provider、行为与成本。
- Durable 后台工作与 Invocation Channel 属于基线：远端子 Session 流经父 Agent 在 `GET /eve/v1/session/:parentSessionId/subagents/:callId/:childSessionId/stream` 跟随、`operationId` 幂等建 Session、`POST /eve/v1/task-input/:token` 回调，以及 `mcpChannel()` 的 Durable Agent 工具都运行在 Eveland 的 Durable Deployment Routing 边界上。由于每条受支持的线都支持这些 Route，Agent Gateway 不再维护按操作区分的 Eve 版本下限——窗口本身就是门禁。
- 前端 `stop()` 已不存在；取消是 Durable、由 Hook 持有的 `cancel()` 命令。Eveland 的 Playground 会等待它（包括第一条事件确定 Durable Turn 之前的窗口），并在 Settlement 完成前保持 Stream Attached。
- Workflow 运行在存储 Spec v6 上。平台为每个新构建注入 `@evelandhq/workflow-world@0.14.0`；`@workflow/world-postgres@5.0.0-beta.34` 只存在于历史 Release 中，从不为新构建选用。更老的 Spec v5 World 会在启动门禁处失败。共享 World 还通过 Snapshot 剥离、Block 打包、Checkpoint 与截止期驱动的 Retention 约束物理 Stream 存储。
- MCP Channel 默认 `/eve/v1/mcp` 且可声明其他 `route`；Eveland 的路径透明 Agent Gateway 会保留任一路径及对应的 OAuth Protected-resource Metadata Route。
- Extension 可以提供 Channel、Schedule 与带命名空间的 Subagent；其完整的平台调度与观察集成作为单独的兼容性跟进交付。
- `chatgpt()` 是稳定 API，由 Codex 负责认证——但 ChatGPT 订阅模型在设计上仅限本地：Eveland Deployment 内没有 Codex 登录，钉住 `chatgpt()` 的 Agent 可以部署成功但会在运行期失败。部署的 Agent 请使用 AI Gateway 或服务端认证的 Model。
- `glob` 与 `grep` 不在默认 Agent 工具集中；依赖它们的 Agent 必须在对应 Tool 文件从 `eve/tools/glob` / `eve/tools/grep` 再导出提供的定义（`defineGlobTool()` / `defineGrepTool()` 工厂已随 0.44 一起移出窗口）。
- 子 Agent 可以在 `defineSandbox` 回调中返回 `parent.sandbox` 以共享发起调用的父 Agent 的活 Sandbox；这样的子 Agent 不能再声明受管 Workspace 或 Skill 资源，Eveland 的受管 Backend 替换照常作用于父定义。

**Eve 0.42 吸收了被跳过的 0.40 与 0.41。** 来自 0.40：`task_peek` 从实验性后台任务中移除——任务通知现在直接携带完成结果与失败，被指示去 Peek 的 Agent 需改为依赖通知本身；当结果已被更早的响应覆盖时，按条件投递的任务唤醒可以保持静默。捆绑的 Workflow SDK 新增可选的批量事件写入（`WORKFLOW_BATCH_TRANSITIONS`，默认开启）——平台注入的 World 保持单事件写入路径，运行行为不变。`eve info --json` 现在输出不含 CLI Banner 的合法 JSON。来自 0.41：新增一等的 Linq iMessage/SMS Channel——注意其受管 Vercel Connect 设置路径在 Eveland Deployment 内不可用（与 `chatgpt()` 同理，容器内没有 Vercel Connect 会话），请改用便携的 Partner API Token 路径。来自 0.42 本身：Channel 与 Session 的 `respond()` 只接受精确的响应字面量或经 `parseInputResponses()` 证明的值，Channel 本地元数据无法再泄漏进 Durable Session-inbox Payload；`task_sleep` 框架工具被移除——Task 模式的父 Agent 改为依赖生命周期通知，而非由模型节奏控制的等待。

**Eve 0.44 吸收了被跳过的 0.43。** 来自 0.43：Tool 可以声明 `execution: "background"` 并返回 `task.delegated()` 回执，后台执行器通过 `task.send({ kind: "complete" | "fail" | "cancel" })` 在进程内回报进度与任务终态；开启 `experimental.tasks` 时，本地与远端 Subagent 也走同一条后台工具路径。动态工具的 Approval、Execute 与 Output 回调现在可跨冷启动持久化——捕获了不可序列化值的回调会直接抛出可操作的错误，而不是在 Replay 时静默丢失。远端 Subagent 的每一轮续接都会转发调用者身份，因此在恢复持久化的远端 Session 前请先把两端 Deployment 都升级：只在建 Session 时接受转发的接收方会用 HTTP 400 拒绝这样的续接（父 Agent 保留子 Handle，升级接收方后可重试）。来自 0.44 本身：Eve 自身的 OpenTelemetry 导出默认只保留公开受众的会话——内置消息 Channel 会把对话分类为 `public`、`private` 或 `unknown`，而经由 HTTP 到达的 Session（Eveland 的 Playground 与 Agent Gateway）属于 `unknown`。Eveland 的 Observer 不受影响，因为它是注入的 Hook、自带导出管线；但自行声明了 `otel()` / `agentRuns()` / `otelIntegration()` 的 Agent 将在自己的后端看不到 Playground 与 Gateway 会话，除非设置 `otel({ tracePolicy: () => true })`；`recordInputs` / `recordOutputs` 已废弃，改用由 `redactSpanInputs()` / `redactSpanOutputs()` 组合而成的 `exportPolicy`。在 `eve dev` 下，本地 Trace Spool 现在默认记录 Prompt 与输出，除非设置 `EVE_TRACES_CONTENT=off`。

**Eve 0.44.3 是同一线内的 Patch 滑动。** 0.44.1 起，Eve 自身托管的 Instrumentation 会对 `private` 与 `unknown` Audience 去除模型、工具、审批与投递内容，因此 Playground 与 Agent Gateway 的 Session 通过 Agent 自带的 `otel()` 只导出元数据；Workflow Run 属性新增 `$eve.is_trace_content_visible`，并对这类 Run 省略由内容派生的 `$eve.title`。Eveland 的 Observer 与共享 World 不受影响（二者只读生命周期事件与结构性属性，不读 Eve 的 Instrumentation 内容）。动态工具的 Callback 改为按工具名与阶段绑定、不再按源码位置绑定，编辑 Callback 正文不再有让已暂存审批回放到错误代码的风险；工具已不存在的暂存调用会 Fail Closed。`useEveAgent` 新增 `resume: true` / `resume()` 与 `send(..., { turnPolicy: "steer" })`。自 0.44.3 起，Eve 客户端在 15 秒收不到 Stream 字节后会重连；因此 Gateway 默认每 5 秒写一次 Heartbeat（`EVELAND_GATEWAY_STREAM_HEARTBEAT_MS`），让只是安静的代理 Stream 保持连接，而不是逐跳重连。

**Eve 0.44.4 是又一次不触及平台面的 Patch 滑动。** 顶层 `text` 为空时，Slack 入站消息现在会从 Block Kit Block 与旧式 Attachment 派生文本，警报式 Bot 消息不再以空正文到达模型。`web_fetch` 最多跟随十次重定向并对每一跳重新做 SSRF 检查，非成功的 HTTP 响应改为返回带响应体的纯文本失败结果，而不是让工具调用失败。Channel 的 `fetchFile` 回调新增可选的上下文参数，携带 Channel State。Web Chat 即使 Durable History 仍停在上一轮边界，也能恢复活跃响应。Eve 不再发出自身的 `workflow.stream.follow.read` Tracing Span。

**Eve 0.45 通过单一权威 Source Graph 编译全部来源；Eveland 托管的 Wire Format 均未变化。** Message Stream、Session Inbox、Workflow 存储 Spec 与捆绑的 Workflow SDK 和 0.44.4 逐字节相同；Discovery Manifest 升到 v14（纯加法，见上方基线条目）；0.45.1/0.45.2 两个 Patch 又将其升到 v15，新增同样是纯加法的 `memories` 列表，对应新的一等 Memory Provider（`eve/memory`）。Memory 使用者注意：`fileMemory()` 只在 `eve dev`（进程内）与配置好的 Vercel Deployment（Blob）下自动解析存储后端；在 Eveland Deployment 上必须显式传入 Backend，否则 Agent 会在运行时失败。Agent 作者需要知道的变化：`eve/tools/defaults` 入口被移除，改为按工具拆分的 `eve/tools/<name>` 子路径；`defineBashTool` / `defineReadFileTool` / `defineWriteFileTool` / `defineGlobTool` / `defineGrepTool` 工厂被移除——请改为再导出提供的工具定义。持久 Subagent Session 成为默认且 `experimental.subagentPersistentSessions` 配置键被移除（`false` 不再是退出方式）：Subagent 工具暴露 `agentId`，已完成的子 Session 仍可接收后续消息，`<agents>` 列表自动发布给模型。框架默认的 Config、Sandbox、Home、Health 与 Inspection 路由可被同名 Authored 文件替换，Channel 路由可用 `disableRoute()` 移除。此前一轮审批未决时，后续 Turn 的工具保持可用。前端客户端新增 `resuming` 生命周期状态，表示 Attached Session 正在确认是否有进行中的 Turn。Agent Trace 在 Workflow 执行开始前就确立身份（Agent Trace Schema v2，不再每 200 Turn 轮换），存在采样 Trace 时 Workflow 行携带 `$eve.trace_id`——Eveland 的 Observer 管线不受影响。

**Eve 0.47 吸收了被跳过的 0.46；Workflow 存储 Spec 与捆绑的 Workflow SDK 和 0.45.2 逐字节相同。** 来自 0.46.0：Eve 自身 Tracing 的默认行为反转了 0.44 的 public-only 规则——所有 Audience 的会话都会发出 Span，但只有 `public` 对话记录内容；因此自带 `otel()` 的 Agent 无需 `tracePolicy: () => true` 就能重新看到 Playground 与 Agent Gateway 会话（只有元数据、没有内容；显式的布尔 Policy 保持原行为；Eveland 的 Observer 两种情况下都不受影响）。来自 0.46.1：Message Stream 协议升到 v24——工具输入以 `action.input.appended` 事件流经 Durable 协议、先于验证后的 `actions.requested` 到达，每条事件只携带原始 Delta 与 UTF-16 偏移；默认 Message Reducer 在 `input-streaming` 状态的 dynamic-tool Part 上以 `inputText` 暴露累计的原始输入；当助手文本先于工具调用时，`message.completed` 现在会先于该调用的输入流事件到达。MCP 与 OpenAPI 的 `providedArguments` 回调获得 Replay 稳定的 `callId`，可用于派生按调用的幂等键。来自 0.47.0 本身：运行时 Sandbox Handle 新增 `delete()`——Agent 代码可以永久删除当前 Session 的 Sandbox，下次访问时自动重新配备（见上方基线条目；Eveland 的受管 bwrap Backend 已实现）；Sandbox 的 `onSession` 回调的 `ctx` 现在只携带 Session 元数据——auth 与 Turn 上下文不再可用，请把这类工作移到 `bootstrap` 或 Channel/Session Handler 中——初始化期间的 Sandbox 访问一律通过 `use()`；由 Schedule 发起的后台任务启动改为静默，不再发送启动确认消息，Schedule 创建的 Workflow Run 携带 `$eve.schedule` 用于归因；以 `-thinking` 结尾的 Model Slug 现在能正确解析，而不是报错或悄悄使用基础模型的上下文窗口。来自 0.47.2：无配置 Agent 的隐式默认 Model 改为 `openai/gpt-5.6-luna-fast`（见上方基线条目——请显式钉住 `model`）。

**Eve 0.47.3 是不触及 Eveland 托管面的 Patch 滑动。** 全部 Wire 常量与 0.47.2 相同：Message Stream v24、Discovery Manifest v15、Workflow 存储 Spec 与捆绑的 Workflow SDK。本 Patch 的主要新增是面向 Delegated Subagent 的 Activity 子系统：父 Agent 在派发远端子 Agent 时可传入 `activityObserver`，子部署把工作、动作与阻塞的生命周期以带版本的批量 POST 上报到父部署的 `POST /eve/v1/activity/:token`（Sink 必须与 Delegated Callback 同源）。该路由走 Agent Gateway 的普通公共请求路径——会唤醒休眠 Deployment、照常受窗口门禁约束，Gateway 无需任何改动。Instrumentation Provider 的内容投递现在只取决于各 Provider 自己的 `capture` 声明；丢弃 eve Trace 的 `tracePolicy` 不再关停 AI SDK 遥测（仅含元数据的 AI Span 仍会进入环境 Workflow Trace）；Eveland 的 Observer 是生命周期 Hook 而非 Instrumentation Provider，投递路径不变。其余是开发体验：`eve-tui/<version>` User-Agent 标识、`eve dev` 状态栏的重建进度，以及 Slack 审批卡片修复。

**Eve 0.47.5 与 0.47.6 是不触及 Eveland 托管面的 Patch 滑动。** 全部 Wire 常量与 0.47.3 相同：Message Stream v24、Discovery Manifest v15、Workflow 存储 Spec 与捆绑的 Workflow SDK。0.47.5 往官方 Memory Provider Registry 加入 Supermemory，并把 Eve 内部的 Instrumentation 重构进独立模块树（无行为变化；AI SDK 遥测语义——包括第三方全局 Integration 保持可达——未变，Eveland 的 Observer 兼容矩阵已重新钉住移动后的表达式）。0.47.6 把 `Workflow` 程序执行器换到官方 AI SDK Code-Mode 运行时（QuickJS 引擎支撑），同时保留 Eve 的 Durable Subagent 记账与事件流——变化仅在 Durable Session 内部（按 Turn 的 Subagent 调用记账），对外 Workflow Wire、存储 Spec 与稳定内部 Workflow 集合均未触及。0.47.6 还把 Eve 与新脚手架项目升到 Zod 4.5，新增 Dynamic Connection（编译期 Agent Manifest——构建内部产物，区别于 Discovery Manifest——升到 v45，新增纯加法的 `dynamicConnections` 列表），并新增 Slack Slash-Command Channel Helper。

**Eve 0.47.7 与 0.48.0 把窗口滑到 `0.47.x` / `0.48.x`；Eveland 托管的全部 Wire Format 均未变化。** Message Stream v24、Discovery Manifest v15、Workflow 存储 Spec、捆绑的 Workflow SDK 运行时、Sandbox Backend 合约以及 `eve/client` / `eve/react` 表面都与 0.47.6 逐字节相同（编译后的 Workflow Bundle 只多了一个构建期的 Directive 扫描器）。来自 0.48.0：Tool 的 `execute` 可以是一个 Workflow Body——以 `"use workflow"` 开头，把 Helper 写成 `"use step"` 函数，在 Body 里使用来自 `workflow` 的 `createHook`、`createWebhook` 与 `sleep`，用 `eve/workflow` 的 `ask` 向 Channel 提问；Eve 把每次调用作为 Durable 的 `toolRunWorkflow` Run 执行（第六个稳定内部 Workflow，已纳入 Retention 审计矩阵：它从 Turn Step 内部启动、继承祖先的 Retention Class，未被回答的 `ask()` 若活过其 Turn，则由 Interactive 类截止期回收），并默认把 Turn 停驻到它返回为止，或以 `execution: "background"` 给模型一个回执、结果就绪时再唤醒。`createWebhook()` 的 URL 解析到 `/.well-known/workflow/v1/webhook/:token`，五种 HTTP 方法均可；Agent Gateway 现在把恰好这一路径形状作为普通公共请求转发（凭 Token 认证，与 `POST /eve/v1/task-input/:token` 同一信任模型），同一命名空间下的 `flow` 与 `step` 队列路由仍被拒绝。Session 创建现在在共享 World 接受 Run 后立即回答 `202`、不再等待 Command Inbox 就绪，因此紧接着的后续请求可能看到 `409 session_not_active`；`eve/client` 与 `useEveAgent` 会带退避重试这段短暂间隙，Eveland 的 Playground 直接继承该重试——自定义客户端应等到 `session.waiting` 再发送下一条。Eve 的同 Deployment 内联 Turn 与"路由到接受请求的 Deployment"优化由 `VERCEL_DEPLOYMENT_ID` 开关，Eveland Deployment 不设置它，所以每个 Turn 仍作为 Durable 的 `turnWorkflow` 子 Run 执行，Eveland 的 Run Reconciliation 不受影响。Remote Principal Forwarding 现在可以通过 W3C Baggage 携带来源 Audience 与方向性的 Trace 内容上限；接收方会与自己的 Trace Policy 取交集，畸形断言降级为仅元数据。来自 0.47.7：内置工具行为经由编译期描述符而非运行期按名推断保留；旧版 Eve 持久化的动态工具恢复时不再崩溃；`clientContext` 只作用于其所属的模型调用；`eve/next` 不再抢占宿主应用的 Workflow World；新的 `eve/local-dev` 能力在所有已部署运行时上均为 `undefined`。

对当前最新线，Agent 项目应刷新 Lockfile 并重新部署，才能实际获得 `0.48.0`，即便 `^0.48.0` 这样的 Range 已经允许它。自定义 NDJSON 消费者必须忽略空行与未知事件类型（Stream v24 新增 `action.input.appended`），且不得把后台任务回执当作终态。只有在两端 Deployment 都已升级、接收方能点名信任的 Forwarder 时，才开启 Remote Principal Forwarding。

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
