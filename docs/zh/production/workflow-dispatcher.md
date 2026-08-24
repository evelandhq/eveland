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

Dispatcher 在启动 runner 和执行 boot recovery 前必须等待 Platform API 的公开 `/health` 成功——并行进程的启动顺序不由 Graphile Job 的首次失败承担；健康门打开后的 Activation、Executor Dispatch 与重试语义仍由 Dispatcher 持有。取得生命周期 Advisory Lock 后，Dispatcher 先从 Active Run 的精确 `wfrun:<tenant>:<run>` Queue 收集旧 Graphile Worker Id 并强制解锁，随后 Re-enqueue，最后才启动新 Worker Pool。第二个 Dispatcher 必须 Fail Closed；升级时必须先停止旧进程，不能用新锁推断旧 Generation 已退出，也不能省略 Per-run QueueName 或批量清空所有 Queue Lock。

Registration 由实际持有 Ownership Lock 的 Dispatcher 通过受服务认证的 Heartbeat 上报，内容包括 Instance/Generation、Ownership、Boot Recovery 完成、World Cluster Identity、Schema Generation、Dispatch Protocol 窗口、状态与时间。Cluster Identity 是从数据库自身读取的 `cluster:<pg system_identifier>/<database>`（绝不含凭据），双方严格相等比较——URL/Host 形态的比较会在不相关集群间 Fail Open，禁止使用。生产中共享构建与 `workflow_step` 激活都以该 Registration 的新鲜度（`EVELAND_WORKFLOW_DISPATCHER_HEARTBEAT_TTL_MS`）Fail Closed；`workflow_step` 激活的调用方还必须以 `x-eveland-dispatcher-instance` Header 携带与该 Registration 完全一致的 Instance Id——绑定的是通过 Readiness 门禁的那个进程，而不是任何持有 Service Token 的进程——不一致返回 409。激活还要求目标 Release Attestation 为 `shared`、Enqueue Capability 为 `per_run_queue_v1`、Dispatch Protocol 落在 Registration 声明的窗口内（Protocol 与 Storage 是独立轴，窗口外 Storage 同样返回 `workflow_migration_required` 409）；Dispatcher 不可证明时返回带 `workflow_unavailable` 前缀的 503。`workflow_step` 的激活响应附带协商结果（Selected Protocol 与 Enqueue Capability）。

保持 `EVELAND_REVISION` 与 `EVELAND_RELEASE_CHANNEL` 与 Dashboard、API、Agent Gateway、Worker 完全一致，并在每次升级时从 `/opt/eveland` 重启 Dispatcher。Dispatcher 还负责有界的共享 World 维护（Stream Block Packing、按期限过期）——Durable World 的运行时行为见[Runtime 运维](/zh/docs/operations/runtime)。

下一步[配置 Agent 流量](/zh/docs/production/networking)。

## 深入参考

- [Workflow 架构设计决策](/zh/docs/reference/design/workflow)：外置 Dispatcher 与自建共享 Workflow World 的论证
- [运行时与资源运营](/zh/docs/operations/runtime)：Durable Workflow World 的租户隔离与保留策略
- [配置参考](/zh/docs/reference/configuration)：Dispatcher 环境变量清单与并发参数配置
