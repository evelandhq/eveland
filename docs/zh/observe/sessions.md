---
title: 会话追踪与模型用量
description: 全链路追踪 Agent 会话树结构、子 Agent 协同与真实模型 Token 消耗。
---

在 Eveland 中，会话（Session）与用量（Usage）的可观测性完全集成在平台控制台中，独立于在线调试台（Playground）。无论是通过公开 API、定时调度还是控制台发起的对话，均会统一收录并关联对应的部署版本。

---

## 1. 会话树模型 (Session & SessionNode)

Eveland 将对话建模为树状结构，直观呈现复杂多 Agent 协同流程：

- **根会话 (Root Session)**：用户与主 Agent 发起的完整上下文会话。
- **子会话节点 (SessionNode)**：当主 Agent 唤起子 Agent（Subagent）或执行多步骤任务时，每个分支流程作为一个子节点关联在根会话下。
- **版本溯源 (Deployment Provenance)**：会话中的每条推理轨迹与工具调用均明确打上产生它的部署版本标签，方便对比不同版本的效果。

---

## 2. 真实模型用量统计 (Token Usage)

Eveland 的 Token 统计完全基于底层模型提供商在 `step.completed` 阶段返回的真实数据：

- **输入与输出 Token**：统计 Prompt 与 Completion 的精确消耗。
- **缓存命中 Token**：记录 Cache Read 与 Cache Write，精准评估上下文缓存节省的成本。
- **费用归集 (Cost)**：当模型网关返回计费数据时，平台会自动汇总每次对话及各项目的累计费用。
- **真实不虚构**：若某次调用提供商未返回统计信息，平台会保持留空，绝不进行主观估算。

---

## 3. 遥测韧性与故障隔离

- **遥测不阻塞业务**：即使 OTel Collector 发生临时网络故障，Agent 业务对话也绝不会因此失败或变慢。
- **独立持久化重试**：平台内置存储与外部导出通道（如 Elastic、Langfuse）均配备独立的本地重试缓冲队列。
- **健康监控**：在控制台 **Settings → Instance health** 中可随时检查遥测采集器的健康状态与积压情况。

## 相关参考

- [可观测性行为契约](/zh/docs/reference/observability)：OTLP 数据投影模型与数据保留周期
- [可观测性架构设计决策](/zh/docs/reference/design/observability)：为什么选择 OpenTelemetry 作为唯一协议
- [健康与诊断](/zh/docs/operations/diagnostics)：遥测流水线排障指南
