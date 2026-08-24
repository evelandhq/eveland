---
title: 故障排查
description: 诊断生产安装、Build、Runtime、Routing、Activation 与 Observation 故障。
---

先阅读[健康与诊断](/zh/docs/operations/diagnostics)，将故障分配到正确 Surface。

## Worker 无法启动

运行独立 Preflight 并解决完整列表。常见原因包括相对数据目录、缺少 App/Build User、没有 `/workspace`、缺少 bwrap 或 Sandbox 命令、Backend 未构建、或缺少 `EVELAND_WORKFLOW_WORLD_URL`。该 URL 是生产必填项：每个新构建都使用共享 Workflow World，Legacy 的 `WORKFLOW_POSTGRES_URL` 不能满足此要求。

## Project 一直 Pending

确认 Worker 已启动、与 API 连接同一个 Postgres，并能通过相同绝对数据根目录解析存储的 Source Path。API 接受请求只代表 Job 已入队。

## Build 成功但 Health 失败

检查持久化 Deployment Diagnostic 与 systemd Unit Journal。确认 Agent 绑定分配的 Loopback Port，并响应 `/eve/v1/health`。即使 Cleanup 也失败，捕获的 Diagnostic 仍应保留原始错误。

## Public Host 返回 404、502 或 Cold Start Timeout

检查 Wildcard DNS/TLS、`EVELAND_AGENT_BASE_DOMAINS`、Traefik `/internal` 排除、Route Target 与其 RuntimeInstance。对于 Continuation，应检查 SessionBinding，而不是重新计算 Route Weight。

## Usage 缺失

在 **Settings → Instance health** 检查 Collector/Built-in 存活状态，在 **Settings → Observability** 检查外部 Destination Probe 状态，并检查 Session Usage Completeness。Eveland 只记录 Eve 报告的 Provider Usage，不估算缺失值。

## Docker 无法分配 Agent Bridge Network

每个活跃的 Docker Deployment 占用一个 Bridge 子网，Docker 内置地址池对长期运行的多 Deployment 宿主机来说太小。当 Worker 的 Docker Runtime Preflight 或某次部署因地址池错误失败（"all predefined address pools are subnetted"）时，配置一个不重叠的地址池并重启 Docker：

```json
{
  "default-address-pools": [{ "base": "10.201.0.0/16", "size": 24 }]
}
```

将其合并进 `/etc/docker/daemon.json`，选择一个不与宿主机、VPN 或 Deployment 网络重叠的 Base。示例允许 256 个 Bridge Network。Docker Runtime 启动 Preflight 会创建并删除一个临时 Bridge，使地址池耗尽在接受任何部署 Job 之前就被报告。

## Schedule 未运行

检查 ScheduleVersion、ScheduleRun、Pinned Target、Worker Planner/Dispatcher Log、Prewarm 配置与 Activation State。不要在 Prepared Release 中重新启用 Eve Native Cron Path。

从需认证的 **Settings → About** 开始：确认 API 显示 `EVELAND_ACTIVATION_LEASE_TTL_MS` 与 `EVELAND_COLD_START_TIMEOUT_MS`，Agent Gateway 显示 `EVELAND_API_INTERNAL_URL` 与 `EVELAND_ACTIVATION_RENEW_INTERVAL_MS`，Worker 显示 Idle/Recovery/Reconciliation 值与 `EVELAND_SCHEDULER_PREWARM_MS`。

对 Cron 或手动执行失败，打开 Project Sessions 历史下的 ScheduleRun 详情。它记录状态、尝试次数、错过的 Tick、精确的 Release/Deployment/ScheduleVersion、时间信息、脱敏错误、聚合 Provider Usage，以及零个或多个关联 Session。Dispatch 之前的 `failed` 没有任何虚构 Session。`dispatch_unknown` 表示凭据已兑换但结果丢失，因此 Eveland 有意不自动重放作者编写的副作用。用 Run ID 关联 Project Runtime Log 与 `journalctl -u eveland-<project>-<deployment>.service`；绝不把解密后的 Project Secret、Scheduler 凭据、Affinity Cookie 或原始 env 文件粘贴进 UI 或日志。

返回 Session ID 的 Dispatch 会保持 `running`，直到 Built-in 为每个返回的 Session 投影出 Root Turn Boundary；其 Schedule Lease 使精确的 RuntimeInstance 免于常规 Idle TTL 收割。若该 RuntimeInstance 消失，Reconciliation 记录 `platform.runtime_lost` 并使受影响的 Session 与 ScheduleRun 失败；若在 `EVELAND_SCHEDULE_RUN_MAX_RUNTIME_MS` 之前没有 Boundary 到达，则改记 `platform.runtime_deadline_exceeded`。短暂的 `draining` 过渡会在 Dispatch 前重试，不应表现为终态 ScheduleRun 失败。

## Cold Start 失败或挂起

对比 Deployment 与其最新 RuntimeInstance：`starting` 应有一个合并后的 `ensure_deployment_running` Job，`failed` 保留 `lastError`，`stopped` 是正常休眠状态。检查 API/Agent Gateway Service Token 是否一致、`EVELAND_API_INTERNAL_URL` 是否可达，然后检查所属 Runtime（systemd 用 `systemctl status` / `journalctl`）。客户端中止只释放该请求的 Lease；其他活跃 Lease 必须保留。

## 已知限制

- Eveland 不会自动清理 `EVELAND_SANDBOX_CACHE_DIR` 下的 Sandbox 缓存；磁盘用量随 Durable Session 与唯一模板数量增长。Backend 的显式 Dry-run/List/Prune API 可供运维者使用。
- 每个活跃 Docker Deployment 使用一个 Bridge 子网。容量受 Docker 配置的 `default-address-pools` 约束；推荐的 `/16` 切分为 `/24` 网络允许 256 个并发受管 Network（含同一 Daemon 上的其他 Docker Bridge）。
- 没有 `agent/` 目录的 eve 项目或普通 Node 项目不会获得注入的 Sandbox，运行在 eve 默认 Sandbox 链上。在生产式 `eve start` 下，可选的 `just-bash` Peer 可能缺席；即使安装了，它也不能运行真正的 Node 或 TypeScript 二进制。
- systemd Deployment 进程使用 `systemd-run --collect` 瞬态 Unit，因此宿主机重启后不会自动重启。已 Enable 的 Worker 会重启，把过期的 `ready` RuntimeInstance 对账为 `stopped`/`failed`，下一次 Cron 或 Agent Gateway 请求会冷启动保留的精确 Release。不可变的 Deployment、Route、历史与 SessionBinding 全部幸存；冷启动间隙缺席的只有瞬态进程。

## 深入参考

- [健康与诊断](/zh/docs/operations/diagnostics)：组件可用性监控、日志采集与证据定位矩阵
- [环境变量参考](/zh/docs/reference/environment-variables)：平台全部环境变量与默认值
- [运行时与资源管理](/zh/docs/operations/runtime)：systemd Unit、Bubblewrap 进程与资源配额
- [配置参考](/zh/docs/reference/configuration)：各组件配置归属与生效规则
