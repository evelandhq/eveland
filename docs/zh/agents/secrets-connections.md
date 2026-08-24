---
title: Secrets、Connections 与 Playground authentication
description: 区分 Eve Connections、注入 Agent 进程的运行时值与 Eveland 调用受保护 Agent 时使用的 Credential。
---

Eveland 从概念上严格区分 Eve Connections、注入 Agent 进程的值，以及 Playground 调用 Agent 自有受保护 Eve Route 时使用的 Credential。

## Runtime Secrets

Project Secret 以密文保存，只为目标进程 Materialize。保存、替换或删除 Secret 会为所有 Running/Draining Deployment 排队 Targeted Restart，避免任何 Route 保留旧环境。

变更是异步生效的：每次修改为每个 Running/Draining Deployment（Stable、Preview 与 A/B Target 一视同仁）排队一个 `restart_deployment` Job。每次 Restart 复用不可变 Release，只重建进程环境。测试新值前请等待这些 Job 完成；运维细节见[安全模型](/zh/docs/operations/security)。

管理员维护一套带 Revision 的 Shared Agent Environment，用于共用的 LLM Key 和运行时默认值。它自动应用到每个 Agent Deployment。有效优先级为 Shared Agent Environment、Project Secret，最后是 Eveland Reserved Value，因此 Project 可以覆盖同名共享 Key。

## Eve Connections

Connection 使用 Eve 官方定义：位于 `agent/connections/` 下、供 Agent 访问外部 MCP 或 OpenAPI server 的声明。静态 Connection token 与 API key 可以从 Agent runtime environment 读取 Project Secret；它们不是 Playground credential。

## Playground authentication

在 Playground 中明确选择 Local Development、None、Eveland Identity、Basic、Bearer、Vercel OIDC、Custom Header 或 Generic OIDC Authorization Code。Eveland 不会根据源码、Provider 名称或 Authentication Challenge 猜测方法。

Eveland Identity 发送 Eveland 签发的 Caller Token，让 Agent 的 `evelandIdentity()` AuthFn 看到与真实调用方一致的身份。它没有配置字段：token 代表哪个 Principal 取决于本实例的 Identity Provider。Open 模式用它唯一的共享 Principal；Eveland Internal 用你自己登录的用户，因此同一 Project 的两个成员不会共用 credential。启用 OIDC Provider 时，通过 OIDC 登录的调用方由自己的 Identity Session 签发 Caller Token；Playground 的这一方法本身仍不可用——平台用户与 IdP 用户之间没有可信映射。

含 Secret 的 authentication field 选择 Project Secret。API 在每次 Create、Continue、Cancel 与 Stream 请求时解析当前 Reference；Credential 不进入 Dashboard 或 Agent Gateway 存储。Shared Agent Environment 不能作为 Playground authentication credential。

## 轮换行为

- Project Secret 变化会重启该 Project 的 Live Deployment；Shared Agent Environment 变化会重启所有 Live Deployment。
- Playground authentication 的 Project Secret 每次请求解析，不重启 Agent。
- 已删除的值 Fail Closed，不回退到旧明文副本。
- Secret 值进入诊断脱敏列表，永远不会通过 Client API 返回。

## 深入参考

- [Agent 环境行为契约](/zh/docs/reference/agent-environment)：三层环境变量优先级与 Build 可见变量规则
- [身份与 Caller Token 契约](/zh/docs/reference/identity)：Agent 认证、Principal 与 Caller Token 铸造
- [安全模型与隔离边界](/zh/docs/operations/security)：机密落盘加密、脱敏与进程权限模型
- [Playground 交互与认证参考](/zh/docs/reference/playground)：各种认证方式在 Playground 中的具体行为与限制
