---
title: Workflow Dispatcher
description: 安装唯一的外部 Workflow Dispatcher，驱动 Durable Timer、唤醒与 Continuation。
---

Durable Workflow 只以 External 模式运行：`EVELAND_WORKFLOW_RUNNER` 默认为 `external`，显式设置 `embedded` 会让 Worker 启动直接失败（Fail Closed）。Deployment 从不认领自己的 Workflow Job，因此恰好一个 Workflow Dispatcher 必须与 Worker 并行运行——没有它，Durable Timer、唤醒与 Continuation 永远不会触发。

## 它做什么

Dispatcher 从共享 Workflow 数据库认领 Durable Workflow Job，并把每个 Step POST 回所属的 Agent Deployment；若该 Deployment 已被空闲回收，则先通过 Control API 唤醒它——与 Agent Gateway 的冷启动完全一致。它从不触及 Worker 内部，从不读取 Deployment 文件，也绝不能加载 Tenant 代码：它只与 Postgres 和 Loopback HTTP 通信，并以 systemd `DynamicUser` 非特权运行。

Dispatcher 是单实例的：它在整个生命周期内持有一个 PostgreSQL Advisory Lock。绝不对同一个共享 Workflow 数据库运行多个 Dispatcher 副本。重启廉价且安全——每个认领都保存在 Postgres 中，重启只是短暂停顿加启动恢复，绝不丢失工作。

## 安装 Service

Dispatcher 与 Worker 共用同一个 `/opt/eveland` Checkout，使用相同的 `vX.Y.Z` Tag：

```bash
sudo install -d -m 0750 /etc/eveland
sudo cp infra/systemd/eveland-workflow-dispatcher.env.example /etc/eveland/eveland-workflow-dispatcher.env
sudo cp infra/systemd/eveland-workflow-dispatcher.service /etc/systemd/system/
```

启动 Service 前先配置 Environment File，然后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eveland-workflow-dispatcher
```

进程开始分发后会在 stdout 打印 `workflow-dispatcher: ready`。Unit 限制了重启次数（`StartLimitIntervalSec`/`StartLimitBurst`），因此错误配置会表现为失败的 Unit，而不是无限 Crash Loop。

## 配置 Environment File

`infra/systemd/eveland-workflow-dispatcher.env.example` 注释了每一项。必须与其他组件保持一致的值：

- `EVELAND_WORKFLOW_WORLD_URL`——必须与 Worker 注入 Deployment 的值相同，否则 Dispatcher 会从一个无人写入的数据库认领。当 Deployment 与平台自身进程通过不同名称访问 Postgres 时，设置 `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL`。
- `EVELAND_WORKFLOW_STREAM_COMPACTION`——必须与 Worker 的值一致，使写入侧与终态重写压缩遵循同一策略。
- `WORKFLOW_DISPATCHER_ACTIVATION_API_URL`（通常为 `http://127.0.0.1:4000`）与 `WORKFLOW_DISPATCHER_ACTIVATION_TOKEN`——Control API 及其内部 Service Token；Token 必须与 API 的值一致。
- `EVELAND_SCHEDULER_RUNTIME_SECRET`——必须与 Worker 的值一致：它被注入每个 Deployment，Deployment 的 Workflow World 用它认证入站 Dispatch。
- `EVELAND_OTLP_ENDPOINT`、`EVELAND_OTLP_SERVICE_TOKEN`——Collector 的平台 Receiver。
- `NODE_ENV=production`、`EVELAND_RELEASE_CHANNEL`、`EVELAND_REVISION`——与其他服务对齐。

调优项共用 `WORKFLOW_DISPATCHER_*` 前缀：`CONCURRENCY`、`POOL_SIZE`、`MAX_INFLIGHT_PER_TENANT`、`DISPATCH_TIMEOUT_MS`、`QUEUE_GC_INTERVAL_MS` 以及有界的 `MAINTENANCE_*` 家族。默认值适合单机；只有先按[容量规划](/zh/docs/operations/capacity)核对 Workflow 数据库连接预算后，才提高 In-flight 上限。有一条约束是强制的：`WORKFLOW_DISPATCHER_LEASE_RENEW_INTERVAL_MS` 必须远低于 API 的 `EVELAND_ACTIVATION_LEASE_TTL_MS`，否则超过 Lease 的 Step 会在中途失去 Executor——设为等于或高于 TTL 时 Dispatcher 拒绝启动。完整定义见[环境变量参考](/zh/docs/reference/environment-variables)。

## Registration 与 Revision 对齐

Dispatcher 通过心跳向 Control API 报告机器可读的 Registration（状态、所有权、启动恢复、协议窗口）。生产部署与 Workflow Step 激活以该 Registration 为门槛——systemd `active` 与 stdout Token 都不能替代它：Registration 过期或缺失时，共享构建与 `workflow_step` 激活会以 `workflow_unavailable` 直接失败（Fail Closed）。

保持 `EVELAND_REVISION` 与 `EVELAND_RELEASE_CHANNEL` 与 Dashboard、API、Agent Gateway、Worker 完全一致，并在每次升级时从 `/opt/eveland` 重启 Dispatcher。Dispatcher 还负责有界的共享 World 维护（Stream Block Packing、按期限过期）——Durable World 的运行时行为见[Runtime 运维](/zh/docs/operations/runtime)。

带有共享 World 之前历史的遗留安装需要执行一次性维护停机 Cutover，使用 `EVELAND_WORKFLOW_DISPATCHER_START_MODE=recover-paused`；全新安装永远不需要——参见[升级与回滚](/zh/docs/operations/upgrades)。

下一步[配置 Agent 流量](/zh/docs/production/networking)。
