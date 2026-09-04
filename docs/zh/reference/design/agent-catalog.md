---
title: Agent Catalog 与统一聊天客户端设计决策
description: 为什么 Catalog 是实时派生的只读投影，以及统一 Web 聊天客户端如何解决多 Agent 舰队交互难题。
---

## 1. Catalog 是实时投影，而不是静态注册表

平台接口 `GET /api/agent-catalog` 用于解答一个核心问题：_当前平台有哪些已就绪、可供客户端直接对话的 Agent？_

- **基于客观事实派生**：项目的部署版本默认导出了标准的 `eveChannel(...)`，且生产路由（Stable Route）处于可访问状态。
- **杜绝状态漂移**：没有人工单独维护的“应用上架审批”或静态记录，目录状态始终与底层生产部署严格一致。处于缩容至零休眠（`stopped`）状态的 Agent 依然入选，因为它们在收到请求时可自动被唤醒。
- **稳定托管身份**：使用 `issuer + projectId` 作为持久的 Agent 全局标识，而非易变的临时 URL。当项目域名调整或后端重启时，客户端本地的历史对话依然完好有效。

---

## 2. 客户端中立的认证重定向协议

在建立会话之前，客户端遵循标准的认证协商流程：

1. **遵循 Agent 自身认证**：Catalog 仅仅公示可用性，客户端发起请求时严格遵循 Agent 自身要求的鉴权方式；
2. **标准挑战与返回**：需要 Eveland 统一身份的 Agent 返回 `401 Unauthorized` 与带有授权地址的挑战头；客户端重定向至控制台完成登录并换取短期 Caller Token；
3. **保持客户端极简 (Thin Client)**：客户端无需硬编码任何第三方 IdP 的认证细节或敏感密钥，任何 Web 前端、移动端或终端 CLI 均能以相同方式接入。

---

## 3. 为什么需要统一聊天客户端

当企业运营的 Agent 数量超过员工人数时，为每个业务 Agent 单独开发一套前端聊天页面、设计一套登录逻辑是完全不可持续的。

统一客户端将这一关系彻底反转：

- **开发即上线**：业务开发者只需专注于编写 Agent 核心逻辑并配置 `evelandIdentity()`，发布后即刻出现在企业统一聊天窗口中，开箱可用；
- **全保真流式呈现**：完整呈现思维链推理（Reasoning Trace）、工具调用与中间状态，提供现代大模型的一流交互体验。

## 相关参考

- [身份架构设计决策](/zh/docs/reference/design/identity)：三条互不替换的信任边界与 Caller Token 机制
- [Agent 身份行为契约](/zh/docs/reference/identity)：Agent Catalog 只读投影规格与 `evelandIdentity()` 协议
- [部署第一个 Agent](/zh/docs/agents/first-deployment)：导入带有标准 Eve Channel 的项目并发布

- [安全模型](/zh/docs/operations/security)：外部身份网络策略与浏览器会话隔离
