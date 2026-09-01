---
title: 容量规划
description: 将单机规格映射到并发 Build、运行中 Agent 与 Postgres 连接预算。
---

Eveland 在一台机器上运行一组 Agent，因此实际问题是机器规格如何映射到并发工作负载。三类负载竞争宿主机资源，按内存权重从高到低：

| 负载                                                                   | 内存（典型）    | CPU                 | Postgres 连接                                                           |
| ---------------------------------------------------------------------- | --------------- | ------------------- | ----------------------------------------------------------------------- |
| 一个 **Build**（`npm ci`/`npx eve build`）                             | 峰值 1–2 GB     | 高（突发，约 2 核） | 无——Build 环境有意排除所有数据库 URL                                    |
| 一个 **运行中 Agent**（`npx eve start`）                               | 150–300 MB RSS  | 空闲时低            | 至多 `WORKFLOW_POSTGRES_MAX_POOL_SIZE`（默认 10）+ 它产生的平台请求负载 |
| 核心服务（API、Agent Gateway、Dashboard、Worker、Postgres、Collector） | 合计约 1–1.5 GB | 低                  | 约 30（`DATABASE_POOL_SIZE` × API/Agent Gateway/Worker）                |

## 并发治理

- **运行中 Agent**：没有硬上限。Idle Reaper 会停止五分钟内没有 ActivationLease 的 Agent（`EVELAND_ACTIVATION_IDLE_TTL_MS`），因此稳态数量跟随真实流量，而不是 Project 数量。
- **Build**：每个 Project 至多一个运行中 Job，另加一个全局并发 Build 上限。Worker 启动时按机器推导上限——`max(1, min(⌊RAM / 4 GiB⌋, cores − 2))`，与下方参考表一致——并在启动日志中打印；`EVELAND_MAX_CONCURRENT_JOBS` 可覆盖。超出上限的 Build 留在队列中，而轻量 Job（Restart、Archive、Delete、Import）继续流动。Worker 通过有界 Pump 准入 Job：至多 `WORKER_JOB_CONCURRENCY` 个已 Claim Job 同时执行（派生值 `max(1, min(cores − 1, 3))`），队列非空时连续 Claim，仅在队列排空后暂停 `WORKER_POLL_INTERVAL_MS`（默认 5 秒）。延迟敏感型 Job——Deployment 激活与 Schedule 派发，它们在与 Eve 固定 30 秒的 Command-hook 等待赛跑——优先于排队中的 Build 与 Import 被 Claim。**Settings → Instance health** 的 Workload 区域以 "Running builds N/cap" 显示当前用量。

## Postgres 连接预算

`max_connections` 是运维最先撞到的上限（Agent 启动时报 `FATAL 53300: sorry, too many clients already`），但**连接是记账上限，不是稀缺资源**。在连接真正存在之前，提高 `max_connections` 几乎没有成本；一个空闲 Backend 约 2 MB——300 个基本空闲的连接不到 1 GB。持有这些连接的 Agent 本身比连接昂贵得多，所以先在进程层面耗尽的是 RAM。按此顺序计算：

1. 预算 RAM：`总量 − 2 GB（OS + 核心服务）− Build 数 × 2 GB`，再除以约 0.3 GB 得到可持续的运行中 Agent 数量。
2. 设置 `max_connections ≈ Agent 数 × WORKFLOW_POSTGRES_MAX_POOL_SIZE + 30（核心服务）+ WORKFLOW_DISPATCHER_POOL_SIZE + 余量`。Workflow 负载轻时可调低每 Agent Pool Size，让单实例容纳更多 Agent。Dispatcher 的 Pool（默认 10）是**固定**成本：它不随 Agent 数量增长；提高 `WORKFLOW_DISPATCHER_CONCURRENCY` 以并发更多 Dispatch 也不会提高它——等待 Agent 的 Dispatch 占用的是 Socket，不是连接。

## 参考表

"并发 Build" 一列即 Worker 推导上限在该规格典型宿主机上的执行结果——内存侧每 4 GB 一个 Build，CPU 偏弱的机器受 cores − 2 限制：

| 宿主机 | 并发 Build | 运行中 Agent | `max_connections` |
| ------ | ---------- | ------------ | ----------------- |
| 4 GB   | 1          | 约 5         | 默认 100          |
| 8 GB   | 2          | 约 10–15     | 200               |
| 16 GB  | 3–4        | 约 30        | 300–400           |
| 32 GB  | 6–8        | 约 60        | 400+（Pool 5）    |

## 每 Deployment 上限

每个 Deployment cgroup 受 `EVELAND_MEMORY_MAX`、`EVELAND_CPU_QUOTA` 与 `EVELAND_TASKS_MAX` 约束，每条 Sandbox 命令受 `EVELAND_SANDBOX_*` 预算约束——两种 Adapter 的应用方式见[运行时与资源](/zh/docs/operations/runtime)，默认值见[环境变量参考](/zh/docs/reference/environment-variables)。当内存上限远高于典型的 150–300 MB RSS 时，请按预期并发运行 Agent 数核算：上限只封顶失控进程，并不预留内存。

## 磁盘与网络容量

- `EVELAND_SANDBOX_CACHE_DIR` 下的 Sandbox Cache 随持久化 Session 与唯一 Template 数量增长，且不会自动清理。Vendored Backend 提供 Dry-run 优先的 List/Prune API；应用删除前先检查 Dry Run，绝不手工删除哈希命名目录。
- Release Artifact 由 Retention Sweep 约束（`EVELAND_RELEASE_RETENTION`，最新 Release 与活跃 Target 受保护）。
- 本地 Docker Runtime 下，每个活跃 Deployment 占用一个 Bridge 子网；容量由 Docker 配置的 `default-address-pools` 决定（推荐的 `/16` 切分为 `/24` 允许 256 个并发受管网络）。

## 深入参考

- [为什么是 systemd 而不是 Docker](/zh/docs/reference/design/runtime)：运行时选型与资源密度
- [缩容到零设计决策](/zh/docs/reference/design/scale-to-zero)：进程空闲停止与按需激活机制
- [运行时与资源管理](/zh/docs/operations/runtime)：cgroup 资源限制与 Sandbox 执行预算
- [环境变量参考](/zh/docs/reference/environment-variables)：并发与容量相关环境变量列表
