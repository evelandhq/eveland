---
title: 身份架构
description: 三条互不替换的信任边界、brokered Caller Token，以及认证与授权之间的亮线。
---

## 三条绝不互换的边界

平台登录（Better Auth）、Playground 委托凭证、面向 Agent 的受管身份，
是三个独立的信任域。任何一个都不替代、不静默回退到另一个；session
cookie、成员角色、provider 凭证永远不进入 Caller Token、Agent Gateway
或 Agent。

一条有牙齿的推论：平台成员 id 只用作委托凭证的隔离键。它绝不发送给
Agent，也绝不与 IdP subject 或 email 比较、映射、合并——按 email 撮合
身份是经典的账号接管漏洞，Agent 对"谁在调用"的认知必须完全从它自己能
验证的凭证推导。

## Brokered Caller Token，而不是透传 IdP token

Agent 用 `evelandIdentity()` 认证调用者：由 Eveland 签发、按 Project
定界的短时效 ES256 JWT，凭 Eveland 的 JWKS 离线验证。上游 IdP token
永不转发。

- **解耦就是目的。** Agent 只信任 Eveland issuer；上游是哪家 IdP、运营
  者什么时候换掉它，任何 Agent 和客户端都不用改。token 只携带 Eveland
  内部的 principal 和 realm claim，没有 provider issuer 或外部 subject。
- **透传会泄漏。** 上游 token 把租户的整张身份图（往往还有可刷新的
  凭证）交到每个 Agent 手里，还让每个 Agent 成为运营者接过的每家 IdP
  的 relying party。
- **audience 绑定阻断重放。** `aud=eveland:project:<projectId>` 意味着
  为一个 Agent 签的 token 在其他任何 Agent 那里都是 401。
- **TTL 就是撤销窗口。** 验证是离线自包含的，禁用 provider 只作废
  Identity Session，不作废已签发的 token；短时效（认证模式约一分钟）
  *就是*撤销滞后——用它换掉了在线撤销检查。

## Verifier 不暗示获取方式

Agent 声明如何*验证*凭证，不代表客户端该如何*获取*凭证——Agent 侧的
`oidc()` 可能对应静态 Bearer、授权码流程、client credentials 或 token
exchange，而 `WWW-Authenticate: Bearer` challenge 无法区分它们。所以
Eveland 绝不从 Agent 源码、401 或 challenge 推断凭证获取方式；Connection
永远是用户显式选择的配置。任何别的做法都是对用户自以为掌控的安全配置
做静默且不可审计的更改。

## Eveland 负责认证；Agent 负责授权

Realm 只回答一个问题：*这个安装信任哪个外部租户？*它是管理员注册的
allowlist——登录解析到未注册的 Realm 即失败——仅此而已。

这条亮线是用删除来执行的：Realm→Project 授权（schema、UI、API、Catalog
过滤）曾经完整上线，后被移除。哪个部门能用哪个 Agent 是 Agent 的业务
逻辑——财务分析 Agent 按自己的规则只放行财务人员——Eveland 既不配置也不
存储这个映射。

## Open 模式为什么由 Gateway 注入 token

Agent Gateway 的一般规则是透明转发、绝不解释认证协议；Open 模式下对
完全不带 `Authorization` 的请求注入平台签名的 Caller Token，是对这条
规则的蓄意修订。当时记录的论证：

- **注入而不是跳转登录**：open 模式下不存在要保护的身份，跳转登录对
  curl、CI、agent 互调、eve TUI 等非浏览器调用方不可行；
  `WWW-Authenticate: authorization_uri` 在无需认证时也是协议撒谎。
- **绝不覆盖已有 credential**：Agent Gateway 无法验证它（那是 Agent 的
  职责），覆盖会打断每一个自带认证的 Agent——推论是带一个坏 token 比
  不带更糟。
- **open token 选长 TTL**：它不承载真实身份、无撤销语义，短 TTL 保护
  不了任何东西；长 TTL 让 Identity 中断在一个周期内对用户无感。

注入的操作约束（透传规则、缓存、mint 失败时的降级）见
[Agent 身份](/zh/docs/reference/identity)。

## 刻意保留的硬边

- **入站 ID token 直接拒绝 HS256**（只收 RS256/PS256/ES256）：现实世界
  存在配置错误的租户，接受 HS256 等于邀请针对公开 client secret 的算法
  混淆攻击。
- **Nonce 和 PKCE S256 永远开启**——不可配置，把火药直接拆掉而不是写
  说明书。
- **Provider 专属代码住在平台之外。** 第一家集成的假设曾在重写前扩散到
  十一层代码里；provider verifier 现在以外部包发布，核心不携带任何
  provider 常量、环境变量或诊断。逼出决策的论证是*无法证明的干净*——
  只要 provider 残留可能藏在任何地方，你就无法证明代码库是
  provider 中立的。
- **OIDC 模式下 Playground 的平台身份凭证直接不可用**，而不是架桥：
  Playground 用户与 IdP 用户之间不存在可信映射，用 email 造一个就违反
  反合并规则。为了边界干净，真实的能力被放弃了。

## 深入参考

- [Agent 身份行为契约](/zh/docs/reference/identity)：三种 Provider 模式、Caller Token 规范与协议细节
- [Agent Catalog 与聊天客户端](/zh/docs/reference/design/agent-catalog)：统一聊天客户端 Dawn 与 Catalog 投影契约
- [安全模型与隔离边界](/zh/docs/operations/security)：外部身份网络策略、凭据存储与 CORS 保护
- [Playground 交互与认证](/zh/docs/reference/playground)：Playground 认证方法与 OIDC 授权码支持
