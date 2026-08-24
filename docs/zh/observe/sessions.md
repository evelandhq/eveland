---
title: Sessions 与 Usage
description: 用 Deployment Provenance 与 Provider 报告的 Usage 追踪 Root/Child Eve Session。
---

Session 采集独立于 Playground。注入的 Eve Hook 使用 Eveland 私有 OpenTelemetry Provider，将标准 OTLP 发送到托管 Collector；Built-in 再把 Agent LogRecord 投影到 Postgres。直接 Agent 请求、Playground、Schedule 与 Child Session 都可以进入同一历史。用户 Instrumentation 与 Exporter 保持不变。

## Session 模型

平台 Session 是 Root Conversation。每个 Root 或 Subagent Eve Session 都成为 SessionNode。Durable Eve Identity 以 Project 为作用域，每条 Observation 同时保留产生它的 Deployment。

Child 先于 Parent 到达以及 Discovery Race 都是预期情况。Projection 以幂等方式合并 Relationship 与 Provenance，并且不会跟随任意 Remote Subagent URL。

## Usage

Usage 只来自 Eve Provider 报告的 `step.completed.data.usage`：

- Input 与 Output Token
- Cache Read 与 Cache Write Token
- Provider 或 AI Gateway 在有报告时提供的 Cost

缺失 Usage 会明确保持缺失，Eveland 不做估算。At-least-once OTLP Delivery 不会重复累计已投影 Usage。

## Telemetry 健康

Telemetry 故障不能让 Agent Turn 失败。Collector 为 Built-in 与每个外部 Exporter 提供相互独立的持久化 Retry Queue；**Settings → Instance health** 展示 Collector/Built-in 存活状态，**Settings → Observability** 展示外部 Destination Probe 状态。

## 深入参考

- [可观测性行为契约](/zh/docs/reference/observability)：OTLP 批处理存储、SessionNode 树合并规则与数据保留周期
- [可观测性设计决策](/zh/docs/reference/design/observability)：为什么选择 OpenTelemetry 作为唯一遥测传输协议
- [健康与诊断](/zh/docs/operations/diagnostics)：Collector 状态检查与用量完整性排查
