---
title: Eve 兼容性
description: 理解 Eveland 已验证的 Eve 版本窗口与 Fail-closed Policy。
---

在 Eve 发布稳定 Compatibility Contract 之前，Eveland 只支持通过完整兼容矩阵的 Minor Line，并显式变更该窗口。代码中的产品契约支持 `0.55.x` 与 `0.58.x`，验证版本为 `0.55.0` 与 `0.58.1`。Eve 0.56 与 0.57（2026-09-17 被跳过：0.58.0 在任何 Eveland 发布版带上它们之前就已取代二者）、Eve 0.54（2026-09-16 随 0.56 进入一个本就是两条线的窗口而退出）、Eve 0.52 与 0.53（2026-09-15 同时退出）、Eve 0.50 与 0.51（2026-09-12 同时退出）、Eve 0.49（2026-09-07 退出）、Eve 0.48（2026-09-02 窗口滑到它之后即被 0.49.0 取代、被跳过，没有任何 Deployment 在其上运行过）以及 Eve 0.47 及更早版本不再允许 Import、Build、Restart、Activation、Playground、Agent Gateway 或 Schedule Execution。

项目 `package.json` 中允许的 Eve 依赖声明形式为：受支持线内的精确 Patch、锚定在受支持 Minor Patch 上的 `~`/`^` Range，以及 `0.55` / `0.55.x` / `0.55.*`、`0.58` / `0.58.x` / `0.58.*`。缺少 Eve 依赖、跨 Minor 的宽泛 Range 或任何可能解析到窗口之外的声明都会 Fail Closed。项目 Overview、Source 与 Playground 会显示当前 Deployment 对应 Source Revision 的 Eve 依赖版本与平台要求。

窗口是一组经过验证的线，而不是"下限以上的一切"：`0.58.x` 于 2026-09-17 进入，`0.56.x` 与 `0.57.x` 落在包络之内却从未通过验证——0.56 只在 `main` 上被接纳了一天、0.57 只有几个小时，0.58.0 在任何 Eveland 发布版带上它们之前就取代了二者，因此没有任何 Deployment 在其上运行过；它们会以与已退出的线相同的升级提示被拒绝。这次没有任何线退出，因此没有 Deployment 变得不可服务，SDK 的 Peer 下限也不动；`0.55.x` 仍是下限，验证版本仍为 `0.55.0`。0.58 带着 0.57 引入的执行模型（每个 Turn 直接在 Session 自己的 Workflow Run 里运行，而不是每条消息派发一个子 Run），且所有 Wire 面与 0.57 逐字节一致；`0.55.x` 与 `0.58.x` 在 Wire 上只差 0.55 会忽略的新增项（下文的可选 Stream 租约）和一条已退役的旧路由。当某条线退出时，其 Release 由该线构建的 Deployment 从 Eveland 带上收窄后的窗口起就不再可服务：Agent Gateway 对它回答 409，Activation 拒绝它，平台会把仍停在它上面的 Workflow Run 直接结算，而不是继续重试；Eve 无法在另一个 Eve 版本下继续同一个 Session，因此重新构建只会开启新的 Session、无法接续旧的。窗口内每条线都能以 Delivery Id 确认消息，因此每个被接受的 Deployment 都能从 Playground 连上。Peer Range 是两个连续区间的并集（`>=0.55.0 <0.56.0 || >=0.58.0 <0.59.0`），而不是会把被跳过的线也放进来的包络。`0.48.x` 从未通过验证（0.49.0 在数小时内即将其取代，更早的 0.46、0.43 与 0.40/0.41 亦然），继续连同 `0.54.x`、`0.53.x`、`0.52.x`、`0.51.x`、`0.50.x`、`0.49.x`、`0.47.x` 及更早版本一起落在下限之下；`0.59.x` 在通过兼容矩阵之前也不会被接纳。

UI 仅将最新支持线 `0.58.x` 标为绿色。Eve 0.55.x 保持可运行，不过会以红色显示并提醒升级；不受支持的版本同样显示为红色且继续阻断。

## 窗口基线

平台曾为更老 Eve 线保留的兼容路径已全部移除，以下能力是整个窗口的基线：

- Session 只按 ID 寻址。Continuation Token 已从平台中彻底消失：Token 列、基于 Token 的 Reset 翻译以及 `POST /eve/v1/session/reset` Token 路由都已删除。Clear、Compact 与 Reset 位于 `POST /eve/v1/session/:sessionId/{clear,compact,reset}`。
- `localDev()` 只看进程，在 `eve start` 下不放行任何请求；Eveland 上的 Agent 必须改用 `evelandIdentity()`、`httpBasic()` 或 OIDC。
- Channel 消息发送默认 `turnPolicy: "steer"`；Eveland 注入的 Scheduler Adapter 始终显式使用 `"queue"`，因此 Schedule 不会抢占用户正在等待的 Turn。
- 自定义 Sandbox Backend Handle 必须实现保留 Durable Session 的 `stop()` 与 `delete()`——后者永久删除该 Sandbox 的一次性状态、保留共享的 Template 状态；Eveland 会用受管的 bwrap Backend（`@evelandhq/sandbox-bwrap`）替换 Agent 自带的 Backend，两者它都已实现。
- 受支持的构建产出 Discovery Manifest v15；投影器只接受它（仅 0.45.0 产出的 v14 已随 0.45 线一起离开窗口）。v15 携带可选的 `instrumentation` 模块引用与 `memories` 列表。
- Message Stream 协议在整个窗口内统一：每条受支持的线都说 **v25**，其 Append 事件只带 Delta（v24 的累积快照 `messageSoFar` / `reasoningSoFar` 与 UTF-16 的 `inputTextOffset` 已随 0.49 离开窗口）。每个响应仍用 `x-eve-stream-version` 头声明版本，Eveland 的 Playground 与 Agent Gateway 原样转发它；自定义 NDJSON 消费者应继续读取该头，而不是假定形状。0.58（与 0.57 一样）在 v25 之上加了一层可选、单独协商的传输租约：客户端用 `?streamControlVersion=1` 选择加入（`eve/client` 的读取器在启用重连且从绝对游标读取时都会这么做）后，会每 10 秒收到空行心跳，并在空闲 60 秒后收到一行 `{"$eve":"stream.lease-ended","version":1}` 控制帧结束响应，客户端随即从自己的游标重连。0.55.x 的 Deployment 忽略该 Query、从不发送控制帧，0.55.x 的客户端也从不请求它，因此窗口内任意客户端/Deployment 组合都成立；Agent Gateway 原样转发 Query String，并保留自己的 5 秒心跳。
- Eve 的隐式默认 Model 在整个窗口内都是 `openai/gpt-5.6-luna-fast`（0.47.0 与 0.47.1 仍默认 `zai/glm-5.2`）；请显式钉住 `model` 以控制 Provider、行为与成本。
- Durable 后台工作与 Invocation Channel 属于基线：远端子 Session 流经父 Agent 在 `GET /eve/v1/session/:parentSessionId/subagents/:callId/:childSessionId/stream` 跟随、`operationId` 幂等建 Session、`POST /eve/v1/task-input/:token` 回调，以及 `mcpChannel()` 的 Durable Agent 工具都运行在 Eveland 的 Durable Deployment Routing 边界上。由于每条受支持的线都支持这些 Route，Agent Gateway 不再维护按操作区分的 Eve 版本下限——窗口本身就是门禁。
- 前端 `stop()` 已不存在；取消是 Durable、由 Hook 持有的 `cancel()` 命令。Eveland 的 Playground 会等待它（包括第一条事件确定 Durable Turn 之前的窗口），并在 Settlement 完成前保持 Stream Attached。
- Workflow 运行在存储 Spec v7（Sealed Log）上：自 `@evelandhq/workflow-world` 0.18.0 起，World 声明 `mintedSpecVersion()`（默认 7，Deployment 设置 `WORKFLOW_SEALED_LOG=0` 时为 6），用 0.17.0 及更早版本构建的 Release 保留其 Spec 6 的运行，因为平台同时接纳两个世代。窗口内每条线的运行时都接受声明 6 或 7 的 World，并且只比较 World 所声明 `@workflow/*` 的 Major 与 Prerelease 标签（Eve 自带的 Bundle 自 0.54.4 起就是 `5.0.0-beta.51/21/35/44`，0.55.0 与 0.58.1 都带着它，0.57.0、0.58.0 与 0.58.1 只是把同一组版本重新打包了一次）。平台为每个新构建注入 `@evelandhq/workflow-world@0.19.1`，其 `@workflow/world` beta.35 与 `@workflow/world-local` beta.44 与整个窗口自带的版本一致；`@workflow/world-postgres@5.0.0-beta.34` 只存在于历史 Release 中，从不为新构建选用。更老的 Spec v5 World 会在启动门禁处失败。共享 World 还通过 Snapshot 剥离、Block 打包、Checkpoint 与截止期驱动的 Retention 约束物理 Stream 存储。
- MCP Channel 默认 `/eve/v1/mcp` 且可声明其他 `route`；Eveland 的路径透明 Agent Gateway 会保留任一路径及对应的 OAuth Protected-resource Metadata Route。
- Durable Tool 用 `eve/tools` 的 `defineWorkflowTool` 声明，委托写法是 `ctx.agent(target, input)`——Eve 自行推导可重放的调用身份，内联的 `outputSchema` 决定返回类型；父 Turn 上的 Workflow Tool 经由一个有序 Inbox 处理、重试的 Dispatch 可能再开一个 Run，`defaultTools: false` 可让 Agent 跳过 Eve 的可选默认工具。`experimental.workflow.retention: 0` 与 `experimental.workflow.modelCallsPerStep` 在整个窗口内都是可选的 Agent 选项：Retention 偏好以保留属性 `$retention` 记录在 Run 上，Eveland 的共享 World 会存储但不执行它，而更大的 Step 批次会在中断后扩大重放单元。
- `task_update` 工具及其子到父的进度回调在整个窗口内都已不存在：改用子 Session 的 Stream 跟踪后台任务，并预期重叠的后台任务结果会跨 Launch Turn 一起到达父 Agent。
- OpenTelemetry Agent Trace Schema 在整个窗口内都是 4：每次 Activation 都是按 `gen_ai.conversation.id` 分组的 `invoke_agent` Span，模型输入只以 `gen_ai.input.messages` 记录一次，Memory 的 Recall/Capture 有自己的 Span 与 `memory.operation.*` Hook 事件。Eveland 的 Observer 与 Collector 映射不依赖任何 Schema 4 之前的名字，但基于 Agent 自己 `otel()` 导出搭建的 Dashboard 必须面向 Schema 4。
- `tool`、`dynamicTool` 与 `channel` 这几个 Extension 契约会随 Eve 的改造丢弃版本，而窗口里两条线丢弃的并不相同：0.55.x 拒绝针对 0.52 或更早预编译的 Extension，0.58.x 拒绝针对 0.55.x 或 0.56.x 预编译的（0.56 在移除 `experimental_workflow` 时丢弃了 `tool` 36–41 与 `dynamicTool` 35–38，0.57 在移除 Continuation `rekey` 与旧的 Session 历史迁移时丢弃了 `tool` 42–43、`dynamicTool` 34 与 39–40、`channel` 19–22，0.58 本身只新增了 `tool` 45、`dynamicTool` 42–43、`subagent` 16、`connection` 20、`dynamicSkill` 20 与 `dynamicInstructions` 21）。因此预编译的 Extension 必须针对项目实际构建所用的线重建；Eveland 自行注入的 Extension 从源码编译，不受影响。Eve CLI 默认向 Vercel 上报使用情况，除非设置 `EVE_TELEMETRY_DISABLED`；Eveland 为其运行的每次 Build 与每个 Deployment 都设置了它。
- Extension 可以提供 Channel、Schedule 与带命名空间的 Subagent；其完整的平台调度与观察集成作为单独的兼容性跟进交付。
- `chatgpt()` 是稳定 API，由 Codex 负责认证——但 ChatGPT 订阅模型在设计上仅限本地：Eveland Deployment 内没有 Codex 登录，钉住 `chatgpt()` 的 Agent 可以部署成功但会在运行期失败。部署的 Agent 请使用 AI Gateway 或服务端认证的 Model。
- `glob` 与 `grep` 不在默认 Agent 工具集中；依赖它们的 Agent 必须在对应 Tool 文件从 `eve/tools/glob` / `eve/tools/grep` 再导出提供的定义（`defineGlobTool()` / `defineGrepTool()` 工厂已随 0.44 一起移出窗口）。
- 子 Agent 可以在 `defineSandbox` 回调中返回 `parent.sandbox` 以共享发起调用的父 Agent 的活 Sandbox；这样的子 Agent 不能再声明受管 Workspace 或 Skill 资源，Eveland 的受管 Backend 替换照常作用于父定义。

## 窗口内各版本支持情况

- **Eve 0.55.x（验证版本 `0.55.0`）**：Channel 用 `defineChannel` 的 `audience(input)` 钩子分类谁能观察这段对话，`eveChannel` 也接受 `audience` 选项。在这条线上，默认把匿名调用者归为 `public`、`user` / `service` / `runtime` 主体归为 `private`；0.56 把匿名那一半改了回去、0.58 沿用（见下），因此放行 `none()` 调用者、又自行导出 Trace 的 Agent 在窗口内两条线上的行为并不相同。Eveland 的 `evelandIdentity()` 会话与注入的 Scheduler Channel 在两条线上都归为 `private`。`metadata()` 里的 `audience` 键已弃用：仍设置它的 Channel 会经由一次性警告的回退继续工作，`ChannelAudienceMetadata` 类型已从 `eve/channels` 移除。自定义 `tracePolicy` 除 `audience` 外还收到 `channel`、`mode`、`environment` 与 `principalType`，默认只对 `public` 对话或 development 环境记录内容——Eveland Deployment 始终是 `production`。持久化的 Session Inbox Wire 是版本 7，携带后台任务标签；旧 Session 在读取时迁移。由 Eve 自己触发的 Schedule，若 Turn 启动了后台工作，会保持打开、不发中间输出，直到结果可用再一次性交付；Eveland 的 Scheduler 通过注入的 Channel 启动 Schedule Session，因此 Eveland 上的 Schedule 不受影响。`defineMcpClientConnection` 有可选的 `protocolVersionDiscovery` 开关。

npm 上出现新版本并不自动扩大窗口。新的 Minor 只有在 Changelog 与源码审阅加上完整兼容矩阵之后才会进入；移除旧 Minor 同样是显式的产品变更。

- **Eve 0.58.x（推荐，验证版本 `0.58.1`）**：每个 Turn 直接在 Session 自己的持久化 Workflow Run 里运行，而不再为每条消息派发一个子 Turn Run（0.57 引入的模型），因此一个 Session 在共享 World 里只留下一个长寿命 Run（加上它的 Session Timeout Run），而不是每个 Turn 一个；`turnWorkflow` 这个名字仅为导入仍由 0.45 或更新的 Driver 持有的 Session 而保留，在该 Driver 下一次派发 Turn 时触发。对运行中 Turn 的 Steering 在下一个已提交的 Step 边界生效，不取消进行中的模型或工具工作，并保留该 Turn 的身份与用量；`continuation.rekey()` 被增量式的 `continuation.alias()` 取代，最近选中的别名以 `continuation.token` 暴露。Eve 的 Deployment Handoff——空闲 Session 的已结算状态迁到接受其下一条投递的那个 Deployment——在 Eveland 上不会触发：Agent Gateway 把每个 Session 路由到它绑定的 Deployment，绑定失效时回答 410 而不是改路由，因此 Session 仍像以前一样随其 Deployment 结束；从这条线回滚到 `0.55.x` 也不是透明的（Eve 要求先结束这些 Session）。持久化 Session Stream 获得窗口基线里描述的可选传输租约。模型生成的 JavaScript 由 `eve/tools/workflow` 的 `workflow` 工厂运行（其 `ctx.agent` 调用是本 Turn 自身 Run 的持久化 Step）；实验性的大写 `Workflow` 工具、`experimental_workflow` 与 `workflowMaxSubagents` 都已移除，用过它们的工具文件必须迁移到小写工厂。匿名 `eveChannel` 会话归为 `unknown`（0.54 的行为，0.56 恢复），因此除非 Channel 显式把 Audience 标为 public，它们的内容不会被记录进 preview 或 production 的 Trace；Audience 回调除已弃用的 `auth` 外还收到 `caller` 投影，Connection 授权可用 `credentialOwner` 替代 `principalType`，Activation Span 带上可查询的 Metadata（Run 类型、Session 标题、来源、Audience、Schedule、Trace 内容策略），是同一个 Schema 4 形状上的增量属性。聚合 Registry 包与其组件选择流程已移除：Linear 集成改用 `eve add channel/linear` 与 `eve add connection/linear` 安装。命名的 Workspace Agent 改为在 `/eve/<name>/v1/*` 提供服务而不是 `/eve/agents/<name>/v1/*`；根单 Agent 路由仍在 `/eve/v1/*`，这也是 Eveland 唯一托管的形态（仅含 Agent 的 Workspace 构建在 Import 时按设计被拒绝）。`turn.started` 的动态模型、工具、技能与子 Agent 解析器现在能在 `ctx.messages` 里拿到可见的对话历史。Eve 现在 Peer 依赖 `ai@^7.0.105`；自行声明 `ai` 的 Agent 项目必须满足该 Range，平台的 Playground 也随之升级。不会影响已部署 Agent 的新增项：`eve/experimental/evaluate` 的 `autoModel` 路由（仅 AI Gateway）、`eve/models/anthropic` 与 `eve/models/openai` 直连助手（`anthropic()` 默认 `claude-sonnet-5`，`openai()` 默认 `gpt-5.6-luna-fast`；隐式默认模型仍是 `openai/gpt-5.6-luna-fast`）、基于 Vercel Connect 的自我修改凭据提供者与 Microsoft Teams 引导安装、去掉 `+git.<sha>` 构建元数据的 Sandbox 镜像 Tag，以及以 TUI 为先、用 `/login` 管理本地凭据的 `eve init`。旧的 `/eve/v1/connections/:name/callback/:token` 路由现在回答授权已过期；带 Attempt 的路由不变。`0.58.1` 在 `0.58.0` 之后一小时内发布，也是 `^0.58.0` 现在解析到的版本：它修复了 `eve dev` 下的 `autoModel`，并重新打上带版本的 Workflow Id，依赖、Peer、Exports 与 Bundle 版本均未变化。对当前最新线，Agent 项目应刷新 Lockfile 并重新部署，才能实际获得 `0.58.1`，即便 `^0.58.0` 这样的 Range 已经允许它。

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
