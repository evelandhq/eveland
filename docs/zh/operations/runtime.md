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

## Sandbox 注入与 Workspace

Eve Deployment 的内置 `bash`、`read_file`、`write_file`、`glob` 与 `grep` 必须连接到可执行的隔离 Sandbox，而不能在生产式 `eve start` 下静默退化为缺少 optional peer 的 `just-bash`。平台在 Docker 与 systemd 的 Release 副本中注入 `@evelandhq/sandbox-bwrap`。Release 准备必须替换用户编写的 Sandbox backend，但保留 authored `bootstrap()`、`onSession()`、`description` 与 `revalidationKey`：注入器把有效 authored definition 原地改名为同目录的非发现 companion module，再由生成的 `sandbox.js` 展开其字段并最后覆盖 `backend`，因此原 definition 的相对 import 语义不能改变。

每个 Project 的 durable Session workspace 保存在 Release 目录之外；redeploy 或 restart 不得丢失同一 Eve Session 的 `/workspace`。平台还必须保留 `agent/sandbox/workspace/**`：这些 authored seeds 继续由 Eve 编译并在每个新 Session 初始化到 `/workspace/**`，不能因为平台选择 backend 而从 Release 删除。workspace template 必须按不可变 Release 隔离：同步部署更新 seed 后，针对新 Release 创建的 Session 使用其新内容；已有 durable Session 的 `/workspace` 不得被 deploy 覆盖。

Docker 本地开发容器不得获得 Docker socket；为 nested bwrap 增加的 capability/seccomp 配置只属于本地 Docker runtime，Linux production 继续使用 unprivileged systemd+bwrap 边界。Sandbox 命令基线与构建后自检见[宿主机前提](/zh/docs/production/prerequisites)与[诊断](/zh/docs/operations/diagnostics)。

## 持久化 Workflow World

Agent 永远不配置也不依赖持久化 Workflow World；Eveland 拥有完整的生产边界。

- 生产环境必须使用共享 World。缺少 `EVELAND_WORKFLOW_WORLD_URL` 时 Worker 启动即失败（Fail Closed）；API 读取同一变量（设置了 `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL` 时经由它）从数据库本身获取 World 的 Cluster Identity，注册的 Dispatcher 报告其他 Cluster 时拒绝 Workflow-step Activation。`NODE_ENV` 非 production 且未配置 Workflow URL 时，Eveland 不注入任何 World，Eve 保持其本地开发 World。
- Runner 为 External-only：`EVELAND_WORKFLOW_RUNNER` 默认 `external`，显式 `embedded` 会让 Worker 启动 Fail Closed。恰好一个 [Workflow Dispatcher](/zh/docs/production/workflow-dispatcher) 与 Worker 并行运行，负责持久化 Timer、Wake 与 Continuation。它是单实例的，在其生命周期内持有 PostgreSQL Advisory Lock；绝不对同一共享数据库运行多个副本。
- 受支持的 Eve 窗口要求 Workflow Spec v6。每个新 Release 通过生成的 Wrapper 注入 `@evelandhq/workflow-world@0.14.0`——保留 authored agent config，同时强制 `experimental.workflow.world`；固定版本的 World 包在安装时不改动导入源码、`package.json` 与 Lockfile。旧的 `@workflow/world-postgres@5.0.0-beta.34` World 只存在于历史 Release 中，新 Build 永远不会选择它。
- 任何 Deployment 进程启动之前，Worker 先在共享数据库中为该 Project 预置分区；Tenancy 与 Cold-start Recovery 始终以 `tenant_id` 为界。Worker 启动与 Tenant Provisioning 自动应用所有待执行的共享 World Migration，由包内 Advisory Lock 串行化。同一 Project 的各 Deployment 有意共享其 Workflow World（不同 Project 保持隔离），因此不透明的 Task-input Callback 可以经任何兼容 Target 恢复。
- `WORKFLOW_POSTGRES_URL` 是平台保留的运行时名称：同名 Project Secret 仍会存储并在日志中 Mask，但无法把平台 World 重定向到别处。
- 共享 World 的维护属于 Dispatcher：启动时与每分钟执行故障隔离的 Block Packing 与截止期驱动的 Stream/Run Expiry，每轮由 `WORKFLOW_DISPATCHER_MAINTENANCE_*` 变量约束；Snapshot 剥离压缩由 `EVELAND_WORKFLOW_STREAM_COMPACTION` 控制。普通删除让页面可复用，但不保证文件系统立即缩小。
- 每个 Release 持久化 immutable workflow attestation（world kind、package/version、storage spec、dispatch protocol、deployment-side enqueue capability），来源是 release preparation 实际注入的内容，绝不来自记录时的 Worker 环境；runner mode 是启动时输入，不属于 attestation。capability 是 world 的版本事实：不具备 per-run enqueue 的早期 shared world attest 为 `unscoped`。attestation 一经写入不可更改，历史行 migration 为 `unknown`。deploy start、restart、cold activation 等所有启动路径只依据持久化的 attestation 决策：只有 `shared` attestation 的 Release 可以启动；legacy 或 `unknown` 的对象返回带 `workflow_migration_required`/`workflow_unavailable` 稳定前缀的 managed error 并 fail closed，不得按当前环境猜测。
- Bootstrap 幂等且无人值守：新空库可以无人值守完成完整 bootstrap，已有 schema 的 pending migration 同样由 Worker startup 或 Tenant Provisioning 直接幂等执行，`runMigrations` 使用 PostgreSQL Advisory Lock 串行化并发启动，不要求单独的 maintenance-window gate。host 与 Deployment 访问同一数据库所需地址不同时，host 侧一律优先使用显式的 Bootstrap URL；当 Deployment URL 使用 `host.docker.internal` 且除 host 外与 `DATABASE_URL` 完全一致时，Worker bootstrap 复用已可达的 `DATABASE_URL`——平台不得对其他数据库地址关系做猜测。
- Stream 存储边界：World 默认在写入前剥离可由 delta 重建的累计 snapshot，并按 128 个 logical chunk 或 64 KiB 建立 server-side checkpoint；`writeMulti` 最多把 64 个 logical chunk、256 KiB 写入一个 physical block，reader 仍按原 logical chunk id 和 cursor 返回兼容字节。`EVELAND_WORKFLOW_STREAM_COMPACTION=off` 只是写侧与 terminal block rewrite 的紧急开关，reader 始终兼容新旧混合数据。删除窗口外 chunk 意味着更老的 raw cursor 不再保证 replay。
- legacy workflow 的按 Project 物理分库（从 base `WORKFLOW_POSTGRES_URL` 派生的 `eveland_wf_<project>_<digest>` 数据库）只剩历史数据残留：legacy Deployment 已不能启动，Worker 不再为启动路径派生或 bootstrap 派生库；base URL 仅作为枚举与删除派生库的管理连接（数据库角色需要 `CREATEDB`），因此它不再是 production 必需项，只服务仍在删除 legacy Project 的既有安装。
- 在 Deployment 前按路径路由的反向代理必须同时转发 `/eve/` 与 `/.well-known/workflow/`。World 把 Run Callback 投递到 `/.well-known/workflow/v1/flow`；只转发 `/eve/` 会让 Session 能启动而每个 Run 都静默卡住。

此处提到的所有变量的默认值与语义见[环境变量参考](/zh/docs/reference/environment-variables)。

## Workflow Retention Class

共享 World 对新 run 只使用一条完整策略链：显式 `retentionClass` 高于 `workflow-world.retention-class` attribute，attribute 高于 Workflow SDK 的 `$rootRunId`/`$parentRunId` lineage，lineage 高于平台 root invocation context，最后才是 `interactive` 默认值。子 run 直接读取同租户 ancestor 的已存 class，不按 workflow name、timeout 或 callback 猜测；lineage 存在但无法解析时 fail closed。Eve 自身不做 Eveland 专用修改；architecture 门禁读取每个受支持 Eve 发布包中不打版本戳的 workflow 名字集合——取自其打包器 `applyWorkflowTransform` 的默认实参，而不是导出的 `STABLE_WORKFLOW_NAMES`（0.51.0 证明后者可能只是前者的子集）——新增稳定内部 workflow 而未更新审计矩阵时必须失败（最近一次是 Eve 0.51.0 的 Subagent Tool Body：它自己不开 Run，但让每次 Subagent 调用都作为 Workflow Tool 运行；再之前是 0.48.0 中 `"use workflow"` Tool Body 背后的 Tool Run，从 Turn Step 内部启动、继承祖先的 class，未被回答的 `ask()` 若活过其 Turn 则由 interactive 类截止期回收，以及 0.47.3 的 Activity Collector，受 Session Timeout 约束的 root run）。

root source 的产品契约：

| root source                                              | 默认 class                           | 说明                                           |
| -------------------------------------------------------- | ------------------------------------ | ---------------------------------------------- |
| Eveland Markdown Schedule 新建 Session                   | `scheduled`                          | 平台强制，authored options 不可放宽            |
| Eveland handler Schedule 新建 target Session             | `scheduled`                          | cross-channel origin 保持到 owner resolution   |
| Schedule delivery 到既有 Session                         | 保留既有 root                        | continuation 不重新分类                        |
| Playground / public Eve HTTP / ordinary authored Channel | `interactive`                        | Eveland 只做代理，不注入策略                   |
| Eve SDK Session create、MCP/operation invocation         | `interactive`                        | create-once 与 binding 不改变 class            |
| callback、follow-up、reset                               | 既有 root；reset 新 owner 时重新选择 | lineage 优先；新 root 按当前 source            |
| 直接/custom Workflow start                               | 显式 class，否则 `interactive`       | 任意 workflow name 都不能作为策略依据          |
| 审核通过的 durable product operation                     | `persistent`                         | 必须有可观测 owner/reason；不得从 timeout 推断 |

清理调度：scheduled/ephemeral run 在 terminal 后 1 分钟可 compact；成功 run 在 15 分钟后删除非 EOF stream data、24 小时后删除 graph；失败 run 分别保留 1 小时和 7 天；取消 run 分别保留 1 小时和 3 天；interactive（默认）分别为 5 分钟、24 小时和 30 天；persistent 永不自动删除。cleanup 必须按完整 run lineage 判断：任一 descendant 仍 active、为 persistent、持有更晚 deadline 或有效 callback/hook capability 时，整棵 graph 均不得删除。active/waiting run 没有 deadline，EOF marker 永久保留。

历史修复与前向正确性分开。operator 必须先以精确 durable root trigger（当前为 `$eve.trigger = channel:eveland-scheduler`）预览单 tenant 的 root/descendant 图和 mismatch，再按 bounded batch 优先修 active graph；已有 `persistent` 行永不改写，terminal class 更新由数据库 trigger 按原 terminal timestamp 原子重算 deadline。之后只运行正常 bounded maintenance，不允许无界删除或 `VACUUM FULL`。诊断按 tenant、resolved root trigger、run type、workflow name、status 与当前 class 分组，并单独报告错误 root class 与 child/root mismatch；不得根据 title 或稳定 Eve workflow name 本身回填。

## Recovery 与 Reconciliation

Worker 恢复中断的 Activation Job，对账数据库状态与真实进程，并清扫 Orphan `eveland-*-dep_*` Unit。它可以将合法但失管的进程纳入 RuntimeInstance 生命周期，也可以停止没有有效 Deployment Owner 的进程。

宿主机存在 Live Deployment 时永远不要切换 Resolved Runtime。必须先 Drain 所有 Target；每个 Deployment 要继续使用其 `runtimeKind` 记录的 Adapter。

## 删除 Project

`DELETE /projects/:projectId` 是异步的：与 `build-deploy`、`sync-source`、`restart` 一样，它入队一个 Job——`delete_project`——并立即返回 `202`。请求原子地持久化 `deletion_status = 'deleting'`；Dashboard 将 Project 显示为 `Deleting…`，在删除完成前，平台 API 的变更请求返回 `409`。同一 Project 还有其他 Job 在运行时，Worker 不会认领该删除 Job。

Job 先停止所有 `running`/`draining` Deployment——每个 Adapter 都从 Deployment 记录的 `runtimeKind` 解析——然后删除其 Runtime Release 与该 Project 平台管理的 Source、Build、Agent Observability Policy 与 Sandbox 目录。只有位于 `EVELAND_DATA_DIR` 之内的路径才符合删除条件；外部提供的源码路径永远不会被递归删除。数据库记录最后删除。删除 Project 时还必须一并删除其 legacy 派生 workflow 数据库（在项目行删除之前执行，删库失败必须让删除可重试），派生库不得作为孤儿残留；共享库中该 Project 的 partitions 一并 drop，不得扫描或删除其他 tenant。

任一 Stop、Release 删除、文件系统清理或数据库操作失败时，Project 保持 `deletion_status = 'failed'`，错误可见并可重试。Runtime/文件系统清理不是 Postgres 事务，因此重试前部分资源可能已被删除。

## 深入参考

- [为什么是 systemd 而不是 Docker](/zh/docs/reference/design/runtime)：运行时密度与宿主机特权隔离决策
- [缩容到零与冷激活](/zh/docs/reference/design/scale-to-zero)：ActivationLease、Idle Reaper 与进程生命周期
- [安全模型与隔离边界](/zh/docs/operations/security)：Sandbox 边界与 Secret 注入机制
- [容量规划](/zh/docs/operations/capacity)：进程内存、并发构建与 Postgres 连接预算
