---
title: 运行时与资源
description: 在生产宿主机上控制进程生命周期、Cold Activation、CPU、内存、持久化 Workflow World 与 Orphan Recovery。
---

Eveland 将持久化 Deployment Identity 与进程生命周期分开。即使 RuntimeInstance 已停止，Deployment 仍可保留 Release、Preview Host、Route 与 SessionBinding。

## Activation 生命周期

Public Request、Continuation、Stream 与 Schedule 在访问进程前获取 ActivationLease。目标 Dormant 时，API 合并为一个 Activation Job，Worker 使用持久化 Runtime Adapter 启动精确 Release。Agent Gateway 只等待配置的 Cold Start 时间。

最后一个 Lease 结束后，Worker 等待 `EVELAND_ACTIVATION_IDLE_TTL_MS`，再次检查是否出现新保护，然后只停止进程。Upcoming 或 Non-terminal ScheduleRun 会保护其固定 Target。

## Deployment 如何运行

- **Build。**导入的源码被复制到 `EVELAND_DATA_DIR` 下的 `builds/<project>/<release>`；Eveland 只向这份副本注入保留的 Telemetry Hook、Workflow World Wrapper 与 Sandbox Module，绝不改写导入源码。依赖安装与 `npx eve build` 由非特权构建用户在 Build Sandbox 内执行。存在 `pnpm-lock.yaml` 时使用 pnpm Frozen Install，存在 `package-lock.json` 时使用 `npm ci`，只有完全没有 Lockfile 时才使用 `npm install`。
- **Run。**systemd 以确定性的每 Deployment Dynamic User 启动 Transient Unit `eveland-<project>-<deployment>.service`，带 `ProtectSystem=strict`、`NoNewPrivileges`、`PrivateTmp`，只对 Release 目录与 Sandbox Cache 可写。进程绑定 `127.0.0.1:<hostPort>`；Secret 通过 root 所有的 `0600` `EnvironmentFile` 到达，绝不通过 Unit 属性。
- **Health。**Worker 轮询 `http://127.0.0.1:<hostPort>/eve/v1/health` 直到收到任何 HTTP 响应。超时后先捕获有限长度的 Unit State 与 Journal、Mask Project Secret 并持久化该 Diagnostic，再停止 Unit。
- **Idle。**Dormant Deployment 保留其不可变 Release、Route 与 SessionBinding。若导入源码目录已被回收，Cold Activation 与 Schedule Activation 会从不可变 SourceRevision 持久化的 Manifest 元数据恢复包管理器选择。显式 Restart 仍要求 Live Source，源码目录缺失时会在停止当前进程之前失败。

## 每 Deployment 限制

两种 Runtime Adapter 都会把 `EVELAND_MEMORY_MAX`、`EVELAND_CPU_QUOTA` 与 `EVELAND_TASKS_MAX` 应用到每个 Deployment cgroup：Docker 对应 `--memory`、`--cpus` 与 `--pids-limit`，systemd 对应 `MemoryMax`、`CPUQuota` 与 `TasksMax`。注入的 bwrap `run()` 命令还会在 `EVELAND_SANDBOX_RUN_TIMEOUT_MS` 后停止（默认 10 分钟）；需要长期存活的 authored process 必须使用 `spawn()`。设置时需要为 Build、Postgres、核心服务与并发 Cold Start 留出余量——参见[容量规划](/zh/docs/operations/capacity)。

## 持久化 Workflow World

Agent 永远不配置也不依赖持久化 Workflow World；Eveland 拥有完整的生产边界。

- 生产环境必须使用共享 World。缺少 `EVELAND_WORKFLOW_WORLD_URL` 时 Worker 启动即失败（Fail Closed）；API 读取同一变量（设置了 `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL` 时经由它）从数据库本身获取 World 的 Cluster Identity，注册的 Dispatcher 报告其他 Cluster 时拒绝 Workflow-step Activation。`NODE_ENV` 非 production 且未配置 Workflow URL 时，Eveland 不注入任何 World，Eve 保持其本地开发 World。
- Runner 为 External-only：`EVELAND_WORKFLOW_RUNNER` 默认 `external`，显式 `embedded` 会让 Worker 启动 Fail Closed。恰好一个 [Workflow Dispatcher](/zh/docs/production/workflow-dispatcher) 与 Worker 并行运行，负责持久化 Timer、Wake 与 Continuation。它是单实例的，在其生命周期内持有 PostgreSQL Advisory Lock；绝不对同一共享数据库运行多个副本。
- 受支持的 Eve 窗口要求 Workflow Spec v6。每个新 Release 通过生成的 Wrapper 注入 `@evelandhq/workflow-world@0.12.0`——保留 authored agent config，同时强制 `experimental.workflow.world`；固定版本的 World 包在安装时不改动导入源码、`package.json` 与 Lockfile。旧的 `@workflow/world-postgres@5.0.0-beta.34` World 只存在于历史 Release 中，新 Build 永远不会选择它。
- 任何 Deployment 进程启动之前，Worker 先在共享数据库中为该 Project 预置分区；Tenancy 与 Cold-start Recovery 始终以 `tenant_id` 为界。Worker 启动与 Tenant Provisioning 自动应用所有待执行的共享 World Migration，由包内 Advisory Lock 串行化。同一 Project 的各 Deployment 有意共享其 Workflow World（不同 Project 保持隔离），因此不透明的 Task-input Callback 可以经任何兼容 Target 恢复。
- `WORKFLOW_POSTGRES_URL` 是平台保留的运行时名称：同名 Project Secret 仍会存储并在日志中 Mask，但无法把平台 World 重定向到别处。
- 共享 World 的维护属于 Dispatcher：启动时与每分钟执行故障隔离的 Block Packing 与截止期驱动的 Stream/Run Expiry，每轮由 `WORKFLOW_DISPATCHER_MAINTENANCE_*` 变量约束；Snapshot 剥离压缩由 `EVELAND_WORKFLOW_STREAM_COMPACTION` 控制。普通删除让页面可复用，但不保证文件系统立即缩小。
- 在 Deployment 前按路径路由的反向代理必须同时转发 `/eve/` 与 `/.well-known/workflow/`。World 把 Run Callback 投递到 `/.well-known/workflow/v1/flow`；只转发 `/eve/` 会让 Session 能启动而每个 Run 都静默卡住。

此处提到的所有变量的默认值与语义见[环境变量参考](/zh/docs/reference/environment-variables)。

## Recovery 与 Reconciliation

Worker 恢复中断的 Activation Job，对账数据库状态与真实进程，并清扫 Orphan `eveland-*-dep_*` Unit。它可以将合法但失管的进程纳入 RuntimeInstance 生命周期，也可以停止没有有效 Deployment Owner 的进程。

宿主机存在 Live Deployment 时永远不要切换 Resolved Runtime。必须先 Drain 所有 Target；每个 Deployment 要继续使用其 `runtimeKind` 记录的 Adapter。

## 删除 Project

`DELETE /projects/:projectId` 是异步的：与 `build-deploy`、`sync-source`、`restart` 一样，它入队一个 Job——`delete_project`——并立即返回 `202`。请求原子地持久化 `deletion_status = 'deleting'`；Dashboard 将 Project 显示为 `Deleting…`，在删除完成前，平台 API 的变更请求返回 `409`。同一 Project 还有其他 Job 在运行时，Worker 不会认领该删除 Job。

Job 先停止所有 `running`/`draining` Deployment——每个 Adapter 都从 Deployment 记录的 `runtimeKind` 解析——然后删除其 Runtime Release 与该 Project 平台管理的 Source、Build、Agent Observability Policy 与 Sandbox 目录。只有位于 `EVELAND_DATA_DIR` 之内的路径才符合删除条件；外部提供的源码路径永远不会被递归删除。数据库记录最后删除。

任一 Stop、Release 删除、文件系统清理或数据库操作失败时，Project 保持 `deletion_status = 'failed'`，错误可见并可重试。Runtime/文件系统清理不是 Postgres 事务，因此重试前部分资源可能已被删除。
