---
title: Agent 身份
description: Identity Provider 三种模式、Caller/App Token 契约、evelandIdentity() 协议与 Agent Catalog 投影的行为参考。
---

Agent 用户身份与平台 Better Auth 登录、Playground authentication credential 是三条互不替换的信任边界；为什么这样切、以及认证与授权之间的亮线，见[身份架构](/zh/docs/reference/design/identity)。本页是行为契约：三种 Provider 模式各自做什么、token 长什么样、`evelandIdentity()` 协议如何走、Catalog 如何投影。运维侧的网络与凭据边界见[安全模型](/zh/docs/operations/security)。

Better Auth cookie/token、member role 与 provider credential 都不得进入 Caller Token、浏览器聊天存储、Agent Gateway 或 Agent。

## Identity Provider 模式

Identity Provider 是实例级的，且任意时刻只能启用一个，三选一。System Admin 选择当前唯一 active Provider、允许的 Identity Realm 与精确 web-chat return origin。切换 Provider 会使既有 Identity Session 不再认证任何人。

- **`Open`**（新实例默认）：Eveland 不认证任何人。它没有 provider 配置，只有一个共享 Realm，也不签发 Identity Session；`/api/identity/login` 返回 `identity_login_not_required`，不做任何跳转——非浏览器调用方无法跟随跳转，且此时并不存在要建立的身份。
- **`Internal`**：API 只在服务端验证有效 Better Auth member，再映射为通用 `ResolvedExternalIdentity`，通过统一的 `finalizeIdentity()` 建立独立 `eveland_identity` Session。
- **`OIDC`**：把身份委托给一个外部 OpenID Connect Provider（authorization code + PKCE S256 + nonce，全部强制开启）。`/api/identity/login` 302 跳转到 IdP 授权端点，`GET /api/identity/oidc/callback`（固定 redirect URI：`<identityIssuer>/api/identity/oidc/callback`，管理员需在 IdP 侧登记）一次性消费登录事务、完成 code 交换与 ID token 验签后，经同一个 `finalizeIdentity()` 建立 Session。ID token 验签只接受非对称算法；client secret 与换回的 access/refresh token 均以 `APP_SECRET_KEY` 派生密钥加密存储。OIDC 模式下 Playground 的 `eveland-identity` 凭据（平台用户直发 Caller Token）不可用——Playground 用户与 IdP 用户之间没有可信映射。

OIDC 模式下调用者的 Realm 按连接配置解析——`connection`（整个连接唯一启用的 Realm）、`id_token_claim` 或 `userinfo_claim`（从指定 claim 取外部 Realm id）——且只允许落在管理员预先登记的 Realm 白名单内，未登记的 Realm 一律 `identity_realm_not_allowed` 403。

## Provider 中立边界

OIDC 的 provider 边界是持久规则：金数据（Jinshuju）的 Eve OIDC verifier 属于外部 `@jinshuju/eve-oidc` 包（`https://github.com/jinshuju/oidc`，API 为 `jinshujuOidc()`）。Eveland 自身不得包含任何 provider-specific OIDC 分支——没有 `jinshuju-oidc` method 常量、`JINSHUJU_OIDC_*` 环境变量、源码扫描特判、自动 Connection 切换或按 provider 名区分的 diagnostics；provider 差异只能通过通用协议配置表达。

已验证的目标 IdP 事实（2026-08-18 discovery 文档）：金数据（`https://account.jinshuju.net`）只支持 code flow，PKCE S256，ID token 仅 RS256，`jwks_uri` 非标准（`/oauth/discovery/keys`），Realm claims 为 ID token 中的 `account_id`/`account_name`/`account_role`，issuer **不带**尾部斜杠；Auth0（per-tenant）issuer **带**尾部斜杠，`org_id` claim 仅在启用 Organizations 时存在，refresh token 需要 `offline_access`。ID token 验签只接受 RS256/PS256/ES256 并直接拒绝 HS256——Auth0 tenant 可能被误配为 HS256，接受它会对公开的 client secret 造成 alg confusion。

## Caller Token

有效 Identity Session 可以请求约 60 秒、ES256、`aud=eveland:project:<projectId>` 的 Caller Token；Eveland 不配置或检查 Realm → Project access。Token 只包含 Eveland 内部 principal/realm claims，不包含 provider issuer、外部 subject 或 provider credential。公开 JWKS 支持 active/retiring key overlap。

Caller Token 只证明调用者身份。Agent 根据 Eveland principal、标准 claims 与自身业务数据决定访问权限，并对不允许的用户返回 `403`。财务部门、产品角色或其他"谁能使用哪个 Agent"规则不属于 Eveland 配置。Eveland 仍可限制可信 provider tenant/Realm，因为这是实例的身份信任边界。

Caller Token 可携带 Eveland 解析并签名的 `agent_url` 供 endpoint-substitution 防护，但该 claim 不表示 Agent 使用 Eveland Identity。

## App Token

已登记的精确 return target origin 还可以在有效 Identity Session 下请求约五分钟的 ES256 App Token，audience 为 `eveland:app:<targetKey>`。App Token 只证明 Eveland principal 与 active Realm 对该聊天应用的登录作用域；聊天应用用它保护自身历史与手动外部 Agent，不能用它替代 Agent credential。

客户端不能因为 Catalog entry 有 `projectId` 就自动取得或发送 Caller Token；必须先遵循 Agent route auth，只有 Agent 要求 `evelandIdentity()` 时才进入 Eveland continuation。（这条约束的对象是**客户端**。平台 Identity Provider 为 `Open` 时 Agent Gateway 自己注入 Caller Token，见下文。）

## `evelandIdentity()` 协议

`evelandIdentity()` 通过标准 `WWW-Authenticate` Bearer challenge 声明 Eveland-owned `authorization_uri`、Project audience 与显示名。多个 AuthFn 的 challenge 可以同时出现；例如 Basic 与 Eveland Identity 仍是 fallback，而不是由 Eveland challenge 抢占。已有 Identity Session 的客户端可静默签发 Caller Token；否则浏览器导航到 `/api/identity/login`。登录 state 随机、短时且只能消费一次，Eveland 根据当前 active Provider 完成认证后签发统一 Caller Token。

Agent Gateway 必须透明转发 challenge、请求 credential 与响应，不解释或改写该协议；它唯一的例外是 open 模式下为无凭据请求注入 Caller Token（见下文），且从不改写已有 credential。

部署 Worker 把 `EVELAND_IDENTITY_ISSUER`、`EVELAND_IDENTITY_JWKS_URL` 和不可由 Project 覆盖的 `EVELAND_PROJECT_ID` 注入 Agent。公开 Agent Gateway 原样转发 Agent-owned Authorization；它不验签、不换 token、不读取 identity claims。Agent 的 `evelandIdentity()` AuthFn 验证 issuer、project audience、ES256、kid、exp/nbf 后建立 `principalType=user`。

## Open 模式的 Caller Token 注入

平台 Identity Provider 为 `Open` 时是唯一的例外：公开 Agent Gateway 在客户端**完全没带** `Authorization` 的情况下注入一个 open 模式 Caller Token。这是对上面「Agent Gateway 不换 token」的**蓄意修订**，其决策理由见[身份架构](/zh/docs/reference/design/identity)。约束：

- 客户端带了任何 `Authorization` 就原样透传，Agent Gateway 绝不覆盖；过期或无效的 token 会让 `evelandIdentity()` 返回 null 并得到 401，清掉即恢复。
- 注入不改变 `x-eveland-*` 剥离与 `eveland_affinity` cookie 剥离。
- 注入**无路径范围限制**：catch-all 代理所有路径，平台签名的 token 会进入 Agent 自写路由，不只 `/eve/v1/*`。
- token 按 Project 分键缓存（audience 是 `eveland:project:<projectId>`），提前刷新；mint 不到时**不带 `Authorization` 转发**，由 Agent 自己的 auth 链决定，而不是由 Agent Gateway 拒绝请求。
- open Caller Token 用 15–30 分钟的长 TTL（默认 20 分钟），Internal 保持约 60 秒。TTL 同时就是切换 Provider 后的撤销滞后：Caller Token 是自包含离线校验，禁用 Provider 只作废 Identity Session，不作废已签发的 token。
- open 模式移除了公网侧唯一的准入门槛，而平台没有 rate limit，且 Deployment 激活发生在 Agent 看到请求之前。

## Agent Catalog

独立且公开的 `GET /api/agent-catalog` 提供 Agent Catalog 只读投影。它不要求 Identity Session，所有调用者得到完全相同的列表，Realm 不参与 Project 过滤。Catalog 只返回 Stable route 当前全部正权重 Deployment 均可路由，且这些 Deployment 对应的不可变 Source Revision 都声明 `capabilities.eveChat=true` 的 Project。`running` 与 scale-to-zero 的 `stopped` Deployment 都可收录。

Catalog 返回 Project ID、Display name、Description、Stable endpoint 与 capability；它不创建独立 Catalog 记录，不动态探测 Agent，不包含或推断 auth 配置，也不提供 marketplace、分类、搜索或审核。`projectId` 是聊天端结合 Eveland issuer 使用的稳定 managed Agent identity，endpoint 变化不得生成新的 Agent 身份。

Source scan 只在标准 `agent/channels/eve.ts`（含受支持的 JS/TS 扩展）明确从 `eve/channels/eve` 导入并默认导出 `eveChannel(...)` 时记录 `eveChat=true`。Catalog 始终读取 Stable route 实际 Deployment → Release → Source Revision，而不是 Project 后来导入但尚未部署的 current Source Revision。没有标准 Eve Channel、没有 Stable Deployment、任一正权重 target 不可路由或未声明 Eve Channel 的 Project 不得出现在结果中。Agent 使用 `none()`、`localDev()`、`httpBasic()`、JWT、OIDC、`evelandIdentity()` 或 custom `AuthFn` 都不改变 Catalog membership。

## 深入参考

- [身份架构设计决策](/zh/docs/reference/design/identity)：三条互不替换的信任边界与 Caller Token 离线校验
- [Agent Catalog 与聊天客户端](/zh/docs/reference/design/agent-catalog)：统一聊天客户端 Dawn 与 Catalog 投影契约
- [Playground 交互与认证](/zh/docs/reference/playground)：Playground 的各认证方法实现与 OIDC 授权码流程
- [安全模型](/zh/docs/operations/security)：外部身份网络策略与 CORS 安全边界
