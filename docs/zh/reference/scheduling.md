---
title: 定时调度执行契约
description: Schedule 发现与编译产物、Planner 与 ScheduleRun 状态机、凭证兑换与工作流保留级别规范。
---

本页规定了 Eveland 作为生产环境唯一定时任务调度器（Scheduler）的执行契约与生命周期规范。

---

## 1. Schedule 发现与构建产物

- **语法支持**：五段式、分钟级的标准 Cron（如 `0 8 * * *`）。
- **时区**：定时任务可以在 `defineSchedule` 或 Markdown frontmatter 里用 eve 的 `timezone` 指定一个 IANA 时区，平台按该时区的本地时钟解读 Cron：`cron: "0 13 * * *"` 加 `timezone: "America/Los_Angeles"` 在太平洋时间 13:00 运行，夏令时为 UTC 20:00，冬令时为 UTC 21:00。不写 `timezone` 时在任何主机上都按 UTC 运行（eve 自己在自托管服务器上会用进程时区）。时区名按规范形式存储（`"utc"` 存为 `"UTC"`）；`"+08:00"` 这样的偏移量或未知时区会让构建失败，且 `timezone` 必须是字符串字面量，平台才能在构建前读到它。跨夏令时切换时平台遵循 eve 自托管的规则：时钟跳过的本地时间在下一个有效本地时间运行（春季拨快那天 `30 2 * * *` 在 03:00 运行），时钟重复的本地时间只在第一次出现时运行一次。
- **来源解析**：代码导入时自动扫描 `agent/schedules/` 下的定义，以及依赖扩展声明的 Extension Schedules。
- **构建产物固化**：编译阶段生成独立的 `.eveland/scheduler/definitions.json` 产物，随不可变 Release 打包。每次代码导入生成不可变的 `ScheduleVersion`。

---

## 2. Planner 与 ScheduleRun 状态机

Worker 以 PostgreSQL 为权威状态源，驱动定时任务调度：

$$\text{queued} \longrightarrow \text{activating} \longrightarrow \text{dispatching} \longrightarrow \text{running} \longrightarrow \text{completed / failed}$$

- **错过周期合并 (Missed Ticks)**：若系统维护停机跨越了多个执行周期，Worker 启动时会自动合并为一个待执行任务，并在 `missedTicks` 字段中记录错过的次数，然后将下次运行时间推进至未来的有效刻度，避免执行雪崩。
- **预热机制 (Prewarm)**：在任务到期前数秒，Planner 自动获取预热租约并按需冷启动休眠的 Agent，确保准点触发时进程已就绪。
- **生命周期保护**：处于任何活跃阶段的 ScheduleRun 会对目标 Deployment 施加硬性回收保护，防止被空闲回收器误停止。

---

## 3. 私有 Scheduler Channel 与凭据兑换

- **关闭 eve 自己的调度器**：每个 Deployment 都带 `EVE_SCHEDULES_DISABLED=1` 运行（属于保留变量，项目条目无法重新打开），因此没有 Deployment 会按 eve 的节奏自行触发，同一项目有多个运行中的 Deployment 时也不会重复执行。作者的定时任务文件保持原样；注入的 Channel 直接导入每个模块定时任务，并内嵌每个 Markdown 定时任务的 prompt。发布准备阶段只从源码读取模块定时任务的 `cron`、`timezone` 以及 `content` 或 `run`，所以定时任务必须用具体的 default export，并以字面量写出这些字段。
- **安全通道派发**：到期时，Worker 使用短期单次凭证调用 Agent 内置的私有 Scheduler Channel。
- **原子兑换**：Channel 在执行用户定义的业务函数前向 API 验证并兑换凭证，确保同一任务不会被重复执行。
- **执行结算边界**：调度启动后，系统等待接收到该会话的终止事件边界（如 `turn.completed` 或 `turn.failed`）才正式结算 ScheduleRun 并释放资源保护。

### 与 eve 自带调度器的差异

eve 会把自己调度器发起的会话标记为定时会话，而 eve 1.0 没有提供让其他派发方做同样标记的公开接口。平台通过 Scheduler Channel 发起定时任务的会话，所以 eve 把它们当作普通的 Channel 会话：

- **登录**：eve 会让定时 turn 中需要连接登录的调用以 `reason: "sign_in_unavailable"` 失败。在 Eveland 上，这个 turn 会发起登录并等待一个没人会给的回应，直到会话超时。请给定时任务使用不需要按用户登录的连接。
- **审批**：Markdown 定时任务的会话在 eve 上没有 Channel，工具需要审批时整个会话失败。在 Eveland 上会话属于 Scheduler Channel，eve 不会预先拒绝审批，而这里也没有人能批准。
- **回复**：eve 只保留定时 turn 的最终回复。在 Eveland 上，模型在等待 task 之前写出的文字会作为单独一条消息发出；handler 往 Slack 等 Channel 发送时会看到这一点。
- **Instrumentation**：eve 的会话上下文里没有这些会话的 `scheduleId`。Eveland 在 Session 上记录了 Schedule、ScheduleRun 和触发方式。

---

## 4. 工作流保留策略 (Workflow Retention)

通过调度器发起的执行统一归类为 **`scheduled`** 保留级别：

- 任务执行完毕后，工作流快照在 1 分钟后进入压缩流程；
- 成功记录保留 24 小时，失败记录保留 7 天以供排障审计。

## 相关参考

- [定时任务与自动化](/zh/docs/observe/schedules)：用户视角下的调度管理与会话观察
- [Workflow 架构设计决策](/zh/docs/reference/design/workflow)：外置 Dispatcher 与持久化任务设计
- [运行时与资源管理](/zh/docs/operations/runtime)：工作流租户隔离与保留策略
