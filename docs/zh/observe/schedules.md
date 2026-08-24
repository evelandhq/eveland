---
title: Schedules
description: 通过 Eveland 以固定 Release、Prewarm 与 Durable Outcome 唯一执行 Eve Schedule。
---

Eveland 接管生产 Schedule Execution。Prepared Release 会中和 Eve Native Cron Handler，并通过私有且经过认证的 Scheduler Channel 暴露项目定义，避免 Preview 与旧 Release 各自重复执行同一业务 Schedule。

## Definition 与 Version

Eveland 为受支持的 Markdown/TypeScript Schedule 接受严格五字段、分钟粒度的 UTC Cron。每个导入 Definition 都成为带版本的平台记录。

## 固定执行目标

Worker 创建 ScheduleRun 时固定所选 Deployment、Release 与 ScheduleVersion。Promote 只影响未来 Run；已经创建的 Run 不会中途跳到其他 Target。

## Prewarm 与 Activation

Worker 在配置的 Prewarm Window 内保持目标温热或将其唤醒，但不会提前执行 Handler。到期 Run 会获得 Runtime Protection，防止 Idle Reaper 停止固定 Target。

错过的 Tick 会合并为一个带明确次数的 Run。对于 Dispatch 结果未知的 Run，重试前先检查 ScheduleRun 状态与 Worker Diagnostic。

## 深入参考

- [调度执行行为契约](/zh/docs/reference/scheduling)：Cron 格式规范、Prewarm/Activation 超时与 ScheduleRun 完整状态机
- [Workflow 调度设计决策](/zh/docs/reference/design/workflow)：为什么使用外置 Dispatcher 驱动 Durable Timer
- [安装 Workflow Dispatcher](/zh/docs/production/workflow-dispatcher)：生产环境部署与配置 Dispatcher 服务
- [Schedule 故障排查](/zh/docs/reference/troubleshooting#schedule-未运行)：诊断 Schedule 未触发或 Dispatch 失败问题
