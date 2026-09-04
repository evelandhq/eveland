---
title: 定时调度执行契约
description: Schedule 发现与编译产物、Planner 与 ScheduleRun 状态机、凭证兑换与工作流保留级别规范。
---

本页规定了 Eveland 作为生产环境唯一定时任务调度器（Scheduler）的执行契约与生命周期规范。

---

## 1. Schedule 发现与构建产物

- **语法支持**：仅接受五段式、UTC、分钟级的标准 Cron 语义（如 `0 8 * * *`）。
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

- **中和本地 Cron**：平台在发布打包阶段会将 Eve 代码自带的本地 Cron 替换为 no-op，杜绝多版本重复触发。
- **安全通道派发**：到期时，Worker 使用短期单次凭证调用 Agent 内置的私有 Scheduler Channel。
- **原子兑换**：Channel 在执行用户定义的业务函数前向 API 验证并兑换凭证，确保同一任务不会被重复执行。
- **执行结算边界**：调度启动后，系统等待接收到该会话的终止事件边界（如 `turn.completed` 或 `turn.failed`）才正式结算 ScheduleRun 并释放资源保护。

---

## 4. 工作流保留策略 (Workflow Retention)

通过调度器发起的执行统一归类为 **`scheduled`** 保留级别：

- 任务执行完毕后，工作流快照在 1 分钟后进入压缩流程；
- 成功记录保留 24 小时，失败记录保留 7 天以供排障审计。

## 相关参考

- [定时任务与自动化](/zh/docs/observe/schedules)：用户视角下的调度管理与会话观察
- [Workflow 架构设计决策](/zh/docs/reference/design/workflow)：外置 Dispatcher 与持久化任务设计
- [运行时与资源管理](/zh/docs/operations/runtime)：工作流租户隔离与保留策略
