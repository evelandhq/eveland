---
title: 密钥、连接与调试认证
description: 掌握项目环境变量、Eve 连接（Connections）以及在线调试（Playground）的凭证配置。
---

在 Eveland 中，配置被清晰地划分为三类：**注入 Agent 的环境变量与密钥**、**Agent 访问外部服务的连接（Connections）**，以及 **Playground 调试调用受保护 Agent 时的客户端凭证**。

## 1. 项目环境变量与密钥 (Project Secrets)

项目密钥用于保存模型 API 密钥、数据库连接串及各类业务配置：

- **加密存储**：所有配置值均在数据库中加密保存，仅在 Agent 进程启动时动态解密注入。密钥绝不会出现在源码、构建产物、日志或观测会话中。
- **自动重启生效**：保存或更新密钥后，平台会异步为该项目当前所有运行中的部署（包括生产、预览及灰度版本）触发环境重载与无损重启（复用已有发布包，仅重构进程环境变量），确保线上不会遗留旧配置。
- **多层级优先级**：
  1. **平台共享环境 (Shared Agent Environment)**：由管理员统一维护，包含通用的基础模型 Key 或默认参数，自动应用于全平台 Agent。
  2. **项目密钥 (Project Secrets)**：项目维度的专属配置。如果与共享环境中的键名冲突，以项目配置为准（支持覆盖）。
  3. **平台保留配置 (Platform Reserved)**：由系统运行时自动注入的内部参数（如端口、实例 ID 等）。

## 2. 外部服务连接 (Eve Connections)

Eve 框架支持在项目源码的 `agent/connections/` 目录下声明外部集成（如 MCP 服务或 OpenAPI 接口）：

- 连接的静态 Token 或 API Key 可以直接通过环境变量引用项目密钥。
- 这些配置属于 Agent **作为客户端**发起出站请求时所用的凭据，与调用 Agent 本身的鉴权无关。

## 3. 在线调试鉴权 (Playground Authentication)

如果你的 Agent 代码中启用了认证保护（如使用了鉴权函数），在控制台的 [Playground](/zh/docs/reference/playground) 调试时需要配置调用凭证：

- **Eveland 统一身份 (Eveland Identity)**：直接向 Agent 传递由平台签发的短期 Caller Token，Agent 的 `evelandIdentity()` 守卫能精准识别当前登录调试的团队成员身份。
- **标准凭证**：支持配置 Basic Auth、Bearer Token、自定义 HTTP Header 或外部 OIDC Token，模拟真实客户端请求。
- **敏感凭证防泄漏**：Playground 中使用的密码或 Token 会在后端单次请求中临时解析，绝不会持久化保存在浏览器或网关日志中。

## 4. 密钥轮换与安全保障

| 变更类型                     | 生效机制                         | 影响范围                 |
| :--------------------------- | :------------------------------- | :----------------------- |
| **修改项目私有密钥**         | 异步重启该项目的所有运行中部署   | 仅当前项目               |
| **修改平台共享环境变量**     | 异步重启全平台的所有运行中部署   | 所有依赖共享环境的 Agent |
| **修改 Playground 调试凭证** | 随下一次请求即时生效，不重启进程 | 仅调试请求               |

所有密钥在系统运行日志与诊断信息中均会被自动脱敏（Masking），防止因异常堆栈打印导致凭证泄露。

## 相关参考

- [Agent 环境变量层级规范](/zh/docs/reference/agent-environment)
- [身份中继与 Caller Token 规范](/zh/docs/reference/identity)
- [安全模型与进程隔离边界](/zh/docs/operations/security)
- [在线调试台 (Playground) 详细指南](/zh/docs/reference/playground)
