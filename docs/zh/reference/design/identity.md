---
title: 身份架构设计决策
description: 三条互不替换的信任边界、Brokered Caller Token 机制与认证和授权的分界线。
---

## 1. 三条相互独立的信任边界

平台控制面登录（Better Auth）、Playground 调试凭证，以及面向业务 Agent 的受管调用方身份，是三个互不混淆的独立信任域：

- 控制面会话 Cookie 或团队成员角色绝不会直接透传给 Agent 进程；
- 平台用户账号与外部 IdP 账号严格隔离，绝不依据邮箱（Email）进行隐式账号合并（防止账号劫持漏洞）。

---

## 2. 为什么使用中继的 Caller Token 而非透传 IdP Token

当 Agent 启用 `evelandIdentity()` 时，Agent 验证的是由 Eveland 签发、按项目定界的短时效 **ES256 Caller Token**，上游 IdP 的原始 Token 绝不直接转发给 Agent：

- **完全解耦外部 IdP**：Agent 仅需信任 Eveland 实例的公钥（JWKS）。未来无论企业更换哪家 IdP（Auth0、Okta 或自建服务），所有 Agent 业务代码与客户端均无需做任何改动。
- **防止凭证滥用与扩散**：上游原始 Token 通常包含租户完整的权限图谱甚至敏感 Refresh Token，透传给不可信的业务脚本会造成凭据泄漏风险。
- **Audience 强绑定防重放**：每个 Caller Token 的 `aud` 严格限定为目标项目（`eveland:project:<projectId>`），无法跨项目复用。
- **短时效换取离线高效验签**：Token 仅在 60 秒内有效，采用离线验签机制，兼顾安全性与极低调用延迟。

---

## 3. 认证 (Authentication) 与授权 (Authorization) 的明确划分

- **平台负责认证 (Who you are)**：通过校验外部 IdP 确认调用者的合法性与所属的租户（Realm 白名单）；
- **Agent 负责业务授权 (What you can do)**：哪个部门或角色可以使用哪个 Agent 属于业务逻辑（例如财务 Agent 根据自身业务规则决定是否放行），Eveland 平台不在基础设施层存储或强行干预业务授权矩阵。

---

## 4. 关键安全设计原则

- **严格拒绝 HS256**：外部 OIDC 验签只接受 RS256/PS256/ES256 非对称算法，直接拒绝对称算法 HS256，彻底免疫针对 Client Secret 的算法混淆攻击。
- **强制启用 PKCE S256 与 Nonce**：OIDC 登录流程中强制开启 PKCE 与防重放 Nonce。
- **Provider 中立性**：Eveland 核心代码保持通用协议规范，不为特定厂商硬编码任何专有逻辑。

## 相关参考

- [Agent 身份行为契约](/zh/docs/reference/identity)：三种 Provider 模式、Caller Token 规范与协议细节
- [Agent Catalog 设计决策](/zh/docs/reference/design/agent-catalog)：统一聊天客户端与 Catalog 投影契约
- [安全模型与隔离边界](/zh/docs/operations/security)：外部身份网络策略与 CORS 保护
