---
title: Agent 身份与 Caller Token 契约
description: 详细规范：三种 Identity Provider 模式、Caller Token 与 App Token 格式、evelandIdentity() 协议与 Agent Catalog 规范。
---

在 Eveland 中，**平台控制面登录态**、**外部调用方身份**与 **Playground 在线调试凭证**是三条相互独立的信任边界。本页定义 Agent 外部身份的协议规范与行为契约。

---

## 1. Identity Provider 三种模式

实例级别全局仅能启用一个 Identity Provider 模式：

| 模式                  | 运行行为                                                                                                   | 适用场景                                             |
| :-------------------- | :--------------------------------------------------------------------------------------------------------- | :--------------------------------------------------- |
| **`Open`** (默认模式) | 平台不强制鉴权。向未携带凭据的入站请求自动注入全平台共享的 Caller Token。                                  | 内部可信局域网或无需用户级细粒度权限的开发测试环境。 |
| **`Internal`**        | 基于服务端已登录的 Better Auth 团队成员身份，置换为统一的 `eveland_identity` 会话。                        | 仅限已开通控制台账号的内部团队成员使用。             |
| **`OIDC`**            | 将用户身份鉴权委托给外部标准 OpenID Connect 供应商（如 Auth0、金数据等）。强制采用授权码模式 + PKCE S256。 | 面向外部最终用户或企业统一部署的 SSO 场景。          |

---

## 2. Caller Token 规范

有效 Identity Session 可向平台请求短期 Caller Token，供调用受保护的 Agent 使用：

- **算法与签名**：采用 **ES256** 非对称签名，通过实例公开的 JWKS（`/.well-known/jwks.json`）验签，支持公钥平滑轮换。
- **Audience 约束**：`aud` 字段强制绑定至具体目标项目：`eveland:project:<projectId>`。
- **有效时间 (TTL)**：在 `Internal` 与 `OIDC` 模式下有效期约为 60 秒；在 `Open` 模式下默认 20 分钟并自动提前刷新。
- **Claims 范围**：仅包含 Eveland 内部的调用主体（Principal ID）与 Realm 信息，绝不包含外部 IdP 的敏感凭证或明文密码。

---

## 3. App Token 规范

已登记的受信前端聊天应用（如 Web Chat 前端）可在有效 Identity Session 下申请约 5 分钟有效期的 App Token（Audience 为 `eveland:app:<targetKey>`）。该 Token 仅证明用户登录态作用域，用于保护聊天历史界面，不可直接作为 Agent 凭据。

---

## 4. `evelandIdentity()` 协议交互流程

当 Agent 源码中使用了 Eveland 专属身份守卫函数时，遵循以下鉴权流程：

```text
客户端请求 Agent (未带凭据)
  → Agent 返回 401 Unauthorized + WWW-Authenticate: Bearer authorization_uri="..."
  → 客户端解析挑战参数，浏览器重定向至 /api/identity/login 完成身份验证
  → 平台签发对应项目的短期 Caller Token
  → 客户端携带 Authorization: Bearer <Caller Token> 重新发起请求
  → Agent 校验 ES256 签名与 Project Audience，识别调用者 Principal 并决定业务授权
```

_注意：Agent Gateway 始终透明转发客户端请求与响应中的 Authorization 与 Cookie，不越权篡改业务凭据。_

---

## 5. Agent Catalog (公共服务目录投影)

平台提供公开只读接口 `GET /api/agent-catalog`，返回当前平台可用的 Agent 列表：

- **收录条件**：目标项目的生产稳定路由（Stable Route）全部正权重部署均健康，且项目源码明确声明了 `capabilities.eveChat=true`（标准 `agent/channels/eve.ts` 导出）。
- **字段规范**：包含 `projectId`、`displayName`、`description`、稳定端点及支持的能力列表。
- **只读中立**：Catalog 仅作为只读投影，不强制做租户过滤，具体的访问控制与权限审批完全交由各个 Agent 自行决定。

## 相关参考

- [身份架构设计决策](/zh/docs/reference/design/identity)：三条信任边界划分与设计权衡
- [Agent Catalog 设计决策](/zh/docs/reference/design/agent-catalog)：统一聊天客户端契约
- [安全模型与隔离边界](/zh/docs/operations/security)：外部身份网络策略与 CORS 配置
