---
title: 架构参考
description: 查看应用 Ownership、Dependency Direction、Data Path 与 Public Request Path。
---

![Eveland 生产拓扑](../../assets/topology-zh.svg)

## 应用 Ownership

| 组件                    | 职责                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| Dashboard               | 经过认证的团队控制台                                                                     |
| API                     | 平台 Contract、Persistence、Auth、Import Handling 与 Built-in OTLP Ingest                |
| Agent Gateway           | Public Agent Data Plane、Trusted Routing、Affinity、Streaming 与 Private Playground Path |
| Worker                  | Import、Build、systemd Runtime Control、Schedule、Recovery 与 Cleanup                    |
| OpenTelemetry Collector | OTLP 接收、Domain Filter、Retry Queue 与 Destination Fan-out                             |
| Workflow Dispatcher     | Durable Timer、Wake 与 Continuation Dispatch；以自己的 systemd Service 或容器运行        |
| Postgres                | 平台状态与唯一的共享 Workflow Database                                                   |

## Dependency Direction

```text
apps → packages
session-collector → core + db
db → core
core → no other Eveland package
apps -X→ apps
```

## Public Request Path

```text
Client
  → wildcard HTTPS Host
  → Traefik
  → Agent Gateway
  → Route Policy / SessionBinding
  → Private Loopback Deployment
  → Eve HTTP Channel
```

## Observation Path

注入 Eve Hook 使用 Eveland 私有 OpenTelemetry Provider，不修改用户 Instrumentation。API、Agent Gateway、Worker 与 Agent 信号通过 OTLP 进入托管 Collector。Built-in 始终启用，将 Agent Log 与 Worker Capacity Metric 投影为 Sessions、Usage 与 Instance Health，不存储原始 Span、LogRecord 或 Metric Point。配置后，Elastic 接收全部 Eveland 信号，Langfuse 只接收 Agent Trace。外部目的地拥有独立 Queue 与空 OTLP Health Probe。Capacity Sample 保留 30 天，派生 Session 与 Usage 保留 90 天，Batch Receipt 保留 24 小时。Playground Streaming 不是权威采集路径。

## 深入参考

- [生产架构概览](/zh/docs/production)：受支持的核心服务、宿主机 Worker 与 systemd 拓扑
- [设计决策总览](/zh/docs/reference/design)：平台结构性选择背后的技术权衡全集
- [为什么是 systemd 而不是 Docker](/zh/docs/reference/design/runtime)：运行时选型与资源密度论证
- [Agent Gateway 不变量](/zh/docs/reference/design/gateway)：网关数据面规则与安全隔离边界
- [可观测性架构决策](/zh/docs/reference/design/observability)：为什么 OpenTelemetry 是唯一遥测传输协议
