---
title: Dashboard 页面契约
description: 登录、Projects、Settings、项目页与 Logs 等 Dashboard 各页面的展示与交互契约。
---

本页集中 Dashboard 每个页面的展示与交互契约。行为跨越平台边界的域各有自己的深度参考：[Agent 身份](/zh/docs/reference/identity)、[源码导入](/zh/docs/reference/source-import)、[Playground](/zh/docs/reference/playground)、[Schedule 执行](/zh/docs/reference/scheduling)、[Agent 环境](/zh/docs/reference/agent-environment)、[可观测性](/zh/docs/reference/observability)。

## 登录 (/login)

平台使用邮箱和密码登录。首次启动时平台幂等创建默认 Admin：

- 默认邮箱：`admin@example.com`，可由 `EVELAND_ADMIN_EMAIL` 覆盖
- 初始密码：必须由 `EVELAND_ADMIN_PASSWORD` 提供，至少 12 个字符
- 用户、密码账户与 Session 使用 Better Auth；团队成员与邀请使用 Organization plugin
- 不内置生产默认密码；`BETTER_AUTH_SECRET` 必须独立配置且至少 32 个字符
- 登录 Session 使用 HttpOnly、SameSite=Lax Cookie；账户连接默认禁止隐式合并
- 已有有效成员 Session 时访问 `/login`，直接跳转到 `/projects`

## Projects (/projects)

展示用户全部项目：项目名称；当前部署状态；最近一次更新时间；当前 Eve 版本（落后于最新支持版本或不受支持时以红色显示，信息提示说明升级目标）；最近 Session 状态；下一次 Schedule 时间（如有，按个人 Display timezone 显示，当天只显示 24 小时制的 `HH:mm`，其他日期显示 `MM-DD HH:mm`）。支持新建项目、删除项目、进入项目。

Project 删除是永久、异步操作。用户必须输入完整 Project 名称确认；API 原子地将 Project 标记为 `deleting` 并创建唯一的 `delete_project` job。Projects 列表在 job 完成前保留该 Project 并显示 `Deleting…`，详情页保持可读但禁用变更操作；删除中的 Project 拒绝新的部署、同步、Secret、Playground 等变更请求。删除失败时 Project 记录保留，展示 `Delete failed` 和失败原因，并允许重试。

删除 job 必须等待同一 Project 已运行的 job 结束，再停止所有 `running` 或 `draining` Deployment。随后按各 Deployment 记录的 `runtimeKind` 删除 Release，清理平台管理的 source、build、Agent observability policy 与 durable sandbox workspace，最后级联删除 routes、SessionBindings、OperationBindings、Sessions、usage、Schedules、Secrets、日志和 Project 数据。平台不得删除 `EVELAND_DATA_DIR` 之外的外部源码路径。外部资源清理无法与 Postgres 组成同一事务；失败时部分进程或 artifact 可能已经停止或移除，但 Project 记录和错误状态必须保留以支持幂等重试。

## 导航外壳

主 Workspace 外壳只应用于 Projects、Deployments 与 Usage。左上角显示 Eveland Logo；左下角显示当前用户头像、姓名和邮箱。整行是单一的 Account Dropdown trigger，菜单提供 Settings 和 Sign out。

Project 详情路由使用独立的 Project 外壳：左上角返回 Projects，其余 Sidebar 只包含当前 Project 的导航；底部上下文区展示当前 Deployment 状态与 Eve 版本，而不是用户信息。当前 Eve 版本标记为健康；较旧但受支持或不受支持的版本通过 Tooltip 给出升级提示。Settings 路由同样使用独立外壳：左上角返回 Workspace，Sidebar 内容按 Personal 与 System 分组，底部不显示用户信息。

## Profile (/settings/profile)

个人设置支持：修改姓名；上传、替换或移除头像（只接受 PNG、JPEG、WebP，最大 512 KB）；查看登录邮箱（当前只读）；配置 Display timezone（未保存偏好时默认使用浏览器当前 IANA 时区，保存后作为个人偏好跨页面和登录 Session 生效）；使用当前密码修改密码（新密码至少 12 个字符，成功后撤销当前 Session 之外的所有登录 Session）。

Dashboard 中所有绝对日期与时间——包括列表、详情、Logs、Session Timeline、ScheduleRun、Usage 与 Instance Health 图表坐标和 Tooltip——统一按当前用户的 Display timezone 展示，不得由 Next.js Server Component 的运行时默认时区决定。Schedule 的原始 cron 和其声明的 `UTC` 时区仍按源码语义展示；`nextRunAt`、due/start/complete 等实际时间点使用个人时区。

Profile 更新复用 Better Auth 用户记录。Better Auth 的 HTTP 面按 allowlist 暴露：仅 `sign-in/email`、`sign-out`、`get-session` 公开可路由，其余端点（含 `update-user`、`change-password`、sign-up、organization、admin 族，以及未来版本新增的任何端点）一律 404——密码修改必须走 Eveland 的 `/profile/password`（强制撤销其他 Session），邀请与成员管理走 Eveland-owned 端点。

## Git Credentials (/settings/git-credentials)

个人设置列出当前用户保存的 Git HTTPS host 凭据，只显示规范化的 host、更新时间和删除操作，不返回、复制或提示 PAT 原值、长度或前后缀。凭据来自两条路径：import 私有仓库成功后自动保存，或在本页手工添加（输入 host 与 PAT，host 规范化为小写并可带端口，拒绝路径、scheme 之外的前缀或内嵌凭据；同一 host 重复添加即替换其 PAT）。手工保存即时生效，不要求先完成一次 import。凭据按 `(userId, host)` 隔离，不能由同一 Team 的其他成员复用。删除后仅影响后续 import/sync，不修改已导入的 Source Revision。

## Members (/settings/members)

Members 位于 Settings 的 System 分组，不再出现在 Workspace 全局导航。角色：`admin` 拥有全部项目权限，并可邀请、移除成员和修改角色；`member` 可管理项目、Secrets 和部署，但不能管理成员。

页面展示活动成员与待接受邀请。Admin 可以：按邮箱创建七天有效、单次使用的邀请链接；刷新邀请以轮换 token 并延长有效期；复制邀请链接或撤销邀请；将成员设为 Admin / Member；移除成员（移除后立即撤销其所有登录 Session，团队项目不删除）。最后一个 Admin 不能被移除或降级。邀请链接使用 256-bit 不透明随机标识，接受后立即失效。移除成员保留底层用户账户：全新邮箱接受邀请时创建成员档案与密码；已有账户的邮箱接受邀请时呈现明确的重新加入流程，使用现有密码登录——接受邀请永远不会重置或替换该密码。

## About (/settings/about)

About 展示当前 Eveland 产品版本、Git revision 与发布 channel。Sidebar 底部持续显示紧凑版本号；About 同时展示 Dashboard build 与 API `/health` 报告的 component build identity。两者的 version、revision 或 channel 不一致时必须明确提示该实例尚未完成一致升级。Worker 没有为此增加公开 HTTP 服务，其 build identity 写入启动日志。

About 还向 Admin 展示 Dashboard、API、Agent Gateway 与 Worker 的只读 runtime configuration 诊断，包括受支持的环境变量名称、所属组件、实际生效值、值来源、用途和缺失/警告状态。Member 不能读取该诊断接口。诊断使用显式 allowlist，不能枚举或原样返回进程的完整 `process.env`；Secret 只显示是否已配置，不能提供查看、复制、长度、前后缀或其他可恢复原值的信息，连接 URL 必须移除 credentials、query value 与 fragment。默认值和派生值按组件的实际 runtime 规则计算并标明来源，未配置的必填项和不安全的开发 fallback 必须明确告警。

Agent Gateway configuration 只能通过现有 service-authenticated `/internal/*` 边界读取，不能加入公开 `/health`。Worker 仍不增加 HTTP 服务：它在 startup preflight 成功后，仅将已经脱敏的 snapshot 以私有权限原子写入共享 `EVELAND_DATA_DIR/diagnostics`，API 再读取该文件；任何 Secret 原值都不能进入该 snapshot、API 响应或 Dashboard payload。组件不可达、snapshot 缺失或无效时 About 显示该组件 unavailable，不能回退为读取其原始环境文件。

Eveland 产品版本与 Project 的 Release/Deployment 是两个独立概念：前者标识平台软件本身，后者仍表示某个导入 Agent 的不可变构建产物与运行目标。

## Instance Health (/settings/health)

Instance Health 位于 Settings 的 System 分组，仅 Admin 可见。它把"当前是否可用"与"是否正在接近容量风险"分开呈现，并至少展示：

- API、Postgres、Agent Gateway、Worker 与 Collector 的当前状态、证据和最后观测时间；Collector 状态来自最近一次 OTLP 批次的到达时间（它是 Built-in 的唯一发送方），过期的批次不能继续证明 Collector 在线
- Worker 持续 heartbeat；启动时配置 snapshot 不能替代在线状态
- Worker 宿主机的 CPU、load、可用内存、`EVELAND_DATA_DIR` 所在文件系统容量与 inode
- queued/running Job 数量、最老 queued Job，以及 RuntimeInstance 状态分布
- 24 小时与 7 天趋势；有足够增长历史时给出磁盘预计耗尽天数

Worker 是唯一采集宿主机指标的特权组件；它把 heartbeat 与 metric sample 作为 capacity domain 的标准 OTLP metrics 发送，Built-in 投影到 Postgres，API 只读取并聚合，Dashboard 只读展示。默认每 60 秒采样、保留 30 天，并每日清理过期 sample。Worker heartbeat 独立于长时间 build/deploy Job 持续发布，不能因为 Job 正在执行而被误判离线。`stopped` RuntimeInstance 是正常 scale-to-zero 状态，不得单独视为故障；Collector delayed/degraded 使实例显示降级，但不等价于 Agent Traffic 已中断。

页面内风险提示不能声称覆盖整机断电：服务器完全失联仍需要外部监控轮询公开的 API 与 Agent Gateway `/health`。Instance Health 不提供 shell、systemd restart 或其他宿主机写操作。

## 项目 Overview (/projects/:projectId)

Overview 默认展示最近七天的执行概况，而不是承担完整的部署管理：Session 数、running 数、terminal Session 完成率与失败数；Input / Output token 总量、Usage coverage 与 Provider/AI Gateway 实际报告的成本；按天的 Session 趋势；最近 Sessions；当前 Production 状态、Eve 版本与 Stable Agent endpoint；下一次已启用 Schedule。

Overview 的主要操作是 Open Playground，并提供前往 Sessions 与 Usage 的下钻。完整的构建、预览、流量与回滚操作位于 Project Deployments。

Project Sidebar 按日常观察优先排列：Overview、Playground、Sessions、Logs、Schedules、Usage，分隔线下是 Deployments、Source、Settings。Logs 保持独立一级入口，不要求用户先从 Overview、Session 或 Deployment 建立特定诊断路径。

## Deployments (/projects/:projectId/deployments)

展示和管理：当前 Production Deployment、Release、Source Revision 与 Stable/Preview endpoint；Deployment 历史、部署时间、runtime kind 与 retention protection；Stable endpoint 当前指向的 target 与流量权重。

主要操作：

- 页面只提供一个 `Create deployment` 主入口，不按动作组合堆叠多个顶层按钮
- Dialog 的 Source 维度默认选择当前不可变 Source Revision；Git 项目可显式选择先同步并验证远端最新代码，Zip 项目只使用当前 Source Revision
- Dialog 的结果维度默认在新 Deployment 通过健康检查后将其原子 promote 为 stable target；用户可显式选择保留为可并发测试的 preview、不改变 stable target
- 提交文案随组合明确显示 `Build & deploy`、`Build, deploy & promote`、`Sync & create preview` 或 `Sync, deploy & promote`，不能用含糊的 `latest` 同时指代当前 Revision 与远端 Git
- Restart deployment
- Open Playground
- 查看日志

## Sessions (/projects/:projectId/sessions)

Sessions 是核心运行历史。列表只展示实际 Eve Session，不把 ScheduleRun execution envelope 作为同级行混入；cron/manual 创建的 Session 仍与其他来源的 Session 一起按 `startedAt` 倒序排列。

每个 Session 展示：Session ID；触发来源（Playground / Cron / Webhook / Channel / API）；关联 Schedule（如由 cron 触发）；开始时间；状态（Running / Completed / Failed / Waiting Approval）；当前 Deployment；Input / Output / Total token 消耗；Usage 完整性（完整 / 部分缺失 / Provider 未报告）。

由 ScheduleRun 创建的 Session 在详情页标题区下方以单行紧凑 provenance 展示 Schedule key、cron/manual trigger、ScheduleRun 状态与开始时间。cron run 同时展示 24 小时制、明确标注 UTC 的人类可读周期和原始五字段表达式；missed tick 与错误仅在存在时显示。完整 Release、Deployment 与多 Session 关系继续通过 ScheduleRun 详情查看。

进入 Session 后展示 Eve 的事件时间线（message → model response → tool call → tool result → step complete → final response / failure）。详情页不展示 span tree 与 LogRecord 明细。Built-in 不存储原始 Agent span 与 LogRecord，span 级别的下钻在启用接收 Agent traces 的外部 Destination 后由该 Destination 提供；用户源码 instrumentation 发送到其自有 backend 的数据不由 Eveland 读取或合并。

同时按实际执行的 Eve agent / subagent 展示：模型调用步数；Input tokens；Output tokens；Cache read / write tokens；Provider 或 AI Gateway 返回的成本（如有）。

支持按 Trigger、Schedule、Status、时间范围筛选。

## Usage (/usage 与 /projects/:projectId/usage)

Usage 是面向开发者与管理员的 Agent traffic 和模型消耗分析页面，不替代 `/settings/health` 的组件、宿主机和容量诊断。Workspace `/usage` 聚合全部 Project，Project Usage 固定为单一 Project；两者复用相同的时间范围、指标定义、趋势图、Model 归因。只有 Project Usage 提供 Session 下钻；Workspace `/usage` 保持运维聚合视角，不混入具体 Session 列表。

页面支持最近 24 小时、7 天和 30 天，并展示当前周期与上一等长周期。统计必须在服务端对完整时间范围聚合，不能把分页 Session 列表的第一页呈现为 Total。至少展示：

- Session 数、running Session、terminal Session 完成率与失败数
- Model step 数，以及 Input / Output / Cache read / Cache write tokens
- Provider 或 AI Gateway 实际报告的成本；不得按公开价目表估算缺失成本
- Usage coverage 与 Cost coverage；两者必须分别计算和呈现
- Sessions、Model steps、Tokens 与 Cost 的时间曲线
- Workspace 的 Project 归因、Model 归因，以及 Eve Agent × LLM Model 归因
- Project Usage 中可下钻的最近 Session

Model 筛选把主趋势图切换为单 Model 视角。此时 Session 数表示在所选时间桶内实际使用该 Model 的 distinct root Sessions，Token、Cost 和 step 数按 model usage event 的时间归入桶。一个 root Session 可以包含多个 Eve agent / subagent 和多个 Model，因此不能给整个 Session 强行标记唯一 Model。无法从受观测 SessionNode 解析 Model 的 step 保留为 `Unknown model`，不能丢弃或猜测。

## Project Settings (/projects/:projectId/settings)

Project Settings 是一个居中的单页，依次包含 Project 详情、Variables 与 Secrets 以及 Danger zone。Project 详情可修改 Display name 与 Description，并只读展示不可变的 Project slug、Project ID 与 Source repository。Variables 与 Secrets 管理 Project 的运行时配置（见 [Agent 环境](/zh/docs/reference/agent-environment)）。旧 `/projects/proj_xxxxxxxxxx/secrets` 路径重定向到 `/projects/proj_xxxxxxxxxx/settings`。

## Logs (/projects/:projectId/logs)

Logs 提供三类日志：Build Log；Deploy Log；Runtime stdout/stderr 与 ScheduleRun lifecycle diagnostics。Agent 的具体执行过程不放在 Logs 中，而放在 Session Timeline 中。

Logs 页面默认按时间倒序展示最新记录，在固定高度滚动区域上方的左侧提供类型 Tabs，右侧提供文本搜索。每条记录默认只显示一行摘要；多行或超长记录可按行展开查看完整原文。

## 深入参考

- [部署第一个 Agent](/zh/docs/agents/first-deployment)：控制台核心部署操作快速入门
- [会话与用量](/zh/docs/observe/sessions)：Sessions 与 Usage 页面背后的数据模型
- [健康与诊断](/zh/docs/operations/diagnostics)：控制台中的健康指标与日志排障矩阵
- [安全模型](/zh/docs/operations/security)：平台认证、邀请与团队成员权限体系
