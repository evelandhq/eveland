---
title: Schedule 执行
description: Schedule 发现与构建 artifact、planner 与 ScheduleRun 生命周期、私有 Scheduler Channel 派发与结算边界的行为参考。
---

Eveland 是生产 Schedule 的唯一调度器。本页是调度面的行为契约：定义如何被发现和构建成 artifact、planner 如何创建与结算 ScheduleRun、派发与凭据兑换语义，以及 Schedules 页面的展示规则。为什么平台要接管 cron 时钟见[缩容到零](/zh/docs/reference/design/scale-to-zero)；用户视角的保证见 [Schedule 观察](/zh/docs/observe/schedules)；排障证据见[故障排查](/zh/docs/reference/troubleshooting)。

## Schedule 发现与构建 artifact

Release adapter 遵循全局 Eve 版本滑动窗口（见 [Eve 兼容性](/zh/docs/reference/eve-compatibility)）；任何可能解析到窗口之外的 Eve 依赖必须在 build 时 fail closed 并返回明确的 adapter diagnostic，不能猜测或降级执行。

导入源码时按 `agent/schedules/` 下的完整相对路径识别 root Schedule key；安装依赖后还从 Eve discovery manifest 读取已解析的 Extension Schedule，并按 Eve 的 `<mount namespace>__<schedule name>` 规则加入同一调度面。目录 mount 中同名 consumer override 优先于 Extension distribution。两种来源都只接受五字段、UTC、分钟级 cron 语义；namespaced key 冲突必须在改写任一模块前使 build 失败，不能静默保留 native cron。

最终 `.eveland/scheduler/definitions.json` 是必须存在并通过 key、cron、Release-relative path 与 definition hash 校验的 build artifact；Docker 与 systemd 都不得回退到依赖安装前的 root-only definitions。每次 Source Revision 保留不可变 ScheduleVersion。Project 另有一个显式 scheduler target，未来 cron/manual run 固定到该 Deployment、Release 和 ScheduleVersion，不通过 Agent Gateway 或 stable route 重新选流量目标。

## Planner 与 ScheduleRun 生命周期

Worker 以 Postgres 为权威状态，使用有界、可多 Worker 并发的 planner 原子创建 ScheduleRun、排入 `trigger_schedule` job、推进 `nextRunAt` 并记录合并的 missed tick。若 worker 停机跨过多个分钟 tick，只为最早的 due time 创建一个 run，并把其余已错过 tick 计入 `missedTicks`，随后把 `nextRunAt` 推进到第一个未来时刻，不做 burst replay。

Worker 使用持久化的 `nextRunAt` 做 schedule-aware scale-to-zero：scheduler target 进入预热窗口后，ready RuntimeInstance 不得被 idle reaper 标记为 `draining`；若它已经停止，planner 获取短期预热 ActivationLease 并排入幂等 activation job。预热只启动固定 Release，不提前创建或执行 ScheduleRun。queued、activating、dispatching 或 running 的 ScheduleRun 对其 pinned Deployment 提供硬性回收保护。

手动运行复用同一条 job 路径。执行前 Worker 获取 `schedule_run` ActivationLease，按 Deployment 记录的 `runtimeKind` 幂等唤醒预构建 Release，再用短期单次 credential 调用 Release 内的私有 Scheduler Channel。Channel 在执行 authored handler 前向 API 原子兑换 credential，并在返回前持久化零个或多个 Eve Session ID；重复 job 或 credential 不得重复执行 authored side effect。

返回零个 Session 的成功 dispatch 立即完成；返回 Session ID 的 dispatch 只表示 authored handler 已启动，ScheduleRun 必须保持 `running`，其 ActivationLease 也必须继续保护对应 RuntimeInstance。Built-in 从 Eveland 私有 OTLP LogRecord 投影出的每个返回 Session 的 root `turn.completed`、`turn.failed`、`turn.cancelled` 或 `session.waiting` 作为本次 schedule execution 的边界；所有返回 Session 都到达边界后才结算 ScheduleRun 并释放 lease。`session.waiting` 可以让持久化对话继续等待后续输入，但不能无限保持进程常驻。

私有 OTLP observation 必须携带启动它的 RuntimeInstance generation，并把该 provenance 保存在 SessionNode 与 SessionEvent 上。Worker 发现该 generation 已停止或丢失时，必须把仍在运行的关联 Session/ScheduleRun 标记失败并记录平台事件；不得让它们永久显示 `running`。如果 terminal turn boundary 永久缺失，Worker 还必须在 `EVELAND_SCHEDULE_RUN_MAX_RUNTIME_MS`（默认 24 小时）的硬截止时间失败关闭。该截止时间是故障保险，与默认 5 分钟的 activation idle TTL 相互独立。

若旧 RuntimeInstance 正在 `draining`，activation 在 credential 兑换前按健康检查预算有界退避，待它停止后创建下一 generation；这属于瞬态等待，不得直接把 ScheduleRun 记为 failed。credential 一旦兑换，仍不得因响应丢失而自动重放 authored side effect。

## Prepared Release 与 Extension integrator

Prepared Release 会保留 root 与 Extension Schedule 的 Eve 注册形状，但将 native cron handler 改为 no-op，因此 warm preview、旧版本和 stable target 不会各自执行同一 cron。当源码声明 Extension mount 时，Extension package 只能在 dependency install 后解析，所以 build 先执行一次 `eve info`，再由 Release 内自包含的 platform integrator 只改写一次性 Release tree（模块使用原子替换，不能修改 pnpm content-addressed store），随后才执行正式 `eve build` 和最终 `eve info`。没有 Extension mount 的 Release 不注入约 11 MiB 的 integrator，也不执行额外的预发现步骤。真正的 Markdown/TypeScript handler 只由经过认证的私有 Scheduler Channel 调用。

## Workflow retention 上下文

私有 Scheduler Channel 还是 workflow retention 的平台策略边界。Markdown Schedule 的 `from(...).send(...)` 与 handler Schedule 暴露的每个 `to(...).send(...)` 都必须在平台拥有的 `scheduled` 运行上下文中执行；这个上下文包在 authored options 之外，authored spread 无法把 Schedule 改成 `persistent`。若 delivery 新建 Session，其 root `workflowEntry` 为 `scheduled`；若 delivery 命中既有 Session，则该 Session 已存 root class 优先，不能因本次 Schedule delivery 被升级或降级。

## Scheduler target 切换

切换 scheduler target 只影响切换后创建的 cron/manual run。已经 queued、running 或完成的 ScheduleRun 永远保留创建时固定的 Deployment、Release 和 ScheduleVersion；promote、rollback 或 stable route 权重变化不得重选其 target。

## Schedules 页面 (/projects/:projectId/schedules)

每个 Schedule 展示：名称；人类可读的 UTC 执行周期，以及作为精确依据的原始 Cron 表达式；时区；是否启用；下一次触发时间；来源文件位置。

每次 cron 或 manual 执行都持久化独立 ScheduleRun；成功且没有创建 Session 也是合法结果。ScheduleRun 保留 Release/Deployment provenance、状态、attempt、missed tick、错误和关联 Sessions，供 Schedules 历史与 Session 详情 provenance 读取。Worker 同时在 Runtime Logs 中按 ScheduleRun ID 记录 pinned Release/Deployment/runtime、activation、Scheduler Channel dispatch 和最终结果阶段，以及端到端耗时。dispatch 超时必须把实际超时预算和目标 Deployment 写入 ScheduleRun 错误与日志，不能只保留底层 `AbortError` 文案；日志不得包含 dispatch credential、runtime secret 或 Project Secret。

Schedule 定义表下方展示最近 50 条 ScheduleRun，并可继续分页。列表默认覆盖全部 Schedule；点击某个 Schedule 的"查看历史"后仍停留在 Schedules 页面，筛选该 Schedule（`schedule_id = 当前 schedule`）并滚动到 Recent runs。

一条 ScheduleRun 恰好关联一个 Session 时，主链接直接进入该 Session 详情。零 Session run 没有可跳转的 Session；多 Session run 也不能任意选择其中一个，因此这两种情况进入 ScheduleRun 详情查看完整执行结果与关联 Sessions。

## 深入参考

- [Schedules 与自动化任务](/zh/docs/observe/schedules)：面向开发者的定时任务配置与执行概览
- [Workflow 架构设计决策](/zh/docs/reference/design/workflow)：为什么使用外置 Dispatcher 与自建 Workflow World
- [缩容到零设计决策](/zh/docs/reference/design/scale-to-zero)：平台接管 Cron 时钟与预热机制的理由
- [故障排查](/zh/docs/reference/troubleshooting#schedule-未运行)：Schedule 执行失败与未按时触发排查指南
