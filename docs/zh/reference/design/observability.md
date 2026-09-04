---
title: 可观测性架构设计决策
description: 为什么采用 Push-first 与 OpenTelemetry 作为唯一遥测传输协议，以及私有 Provider 隔离设计。
---

## 核心决策

Eveland 的遥测全链路统一采用 **OpenTelemetry (OTel) API、标准语义约定与 OTLP 协议**作为唯一的数据传输标准。平台不发明专有遥测信封或私有协议，扇出与重试由托管的 OpenTelemetry Collector 负责。

---

## 1. 为什么采用 Push 模式且在 Release 准备期注入

平台对用户的核心承诺是：**端到端会话追踪必须覆盖每一个流量入口**。

- **单纯网关代理的局限**：如果仅在网关层抓取流量，会静默遗漏直连通信、定时任务调度（Cron）、渠道消息（如 Slack/Webhook）以及子 Agent（Subagent）之间的内部协同流量。
- **为何不拉取事件流**：Agent 若自定义了业务鉴权，外部拉取必须持有最终用户凭证，且定时任务等非 HTTP 流量缺乏对应的拉取凭证。
- **在发布准备期注入**：Eveland 在 Release 准备阶段向 Agent 运行环境中自动注入 Observer Hook，从进程内部主动通过 OTLP 推送结构化事件。注入过程自包含且绝不修改用户的源代码快照。

---

## 2. 私有 Provider：绝不侵入用户全局探针

注入的 Observer 使用 Eveland 独立的私有 OTel Provider：

- 不调用任何全局注册函数（如全局 `TracerProvider` 或 `MeterProvider`）；
- 绝不冲刷（Flush）或关闭用户业务代码自行初始化的 OTel 设施；
- 用户自建的可观测性探针继续向用户配置的后端上报，平台与业务遥测完全互不干扰。

---

## 3. 信任边界与凭据防伪

- **双接收端点分级信任**：Collector 分别在回环端口设置平台接收器（`17311`/`17312`）与 Agent 接收器（`17313`/`17314`）。Agent 接收端点只接受受限的 Instrumentation 范围，无法冒充平台核心服务。
- **服务端强校验归属**：Worker 为每个 Deployment 签名派发专属凭据；Built-in 投影服务在入库时对数据来源进行强制校验，防止 Agent 跨租户篡改会话归属。
- **外部导出凭据不落地 Agent**：Agent 进程不持有任何外部存储（如 Elastic、Langfuse）的 API Key；所有外部导出统一由 Collector 经安全代理转发。

---

## 4. 接受的工程代价

- **可用性高于可观测性**：遥测管道发生拥塞或异常时自动降级丢弃，**绝不允许遥测故障导致正常的业务对话失败**。
- **At-least-once 交付模式**：网络重试可能导致重复接收，因此底层数据库投影逻辑具备完全的幂等性。
- **内置库定位为分析摘要**：平台内置存储仅保存会话树、Token 用量与健康指标等结构化模型；更深度的原始 Span 跟踪留给外部专用 APM 目的地。

## 相关参考

- [可观测性行为契约](/zh/docs/reference/observability)：OTLP 批处理存储、SessionNode 树合并规则与数据保留周期
- [会话与用量追踪](/zh/docs/observe/sessions)：面向开发者的 Session 与 Usage 模型概览
- [健康与诊断](/zh/docs/operations/diagnostics)：Collector 状态检查与用量完整性排查
- [架构参考](/zh/docs/reference/architecture)：系统 Observation Path 与信号拓扑图
