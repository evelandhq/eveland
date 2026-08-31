---
title: 安全模型
description: 理解认证、Secret、Build、Runtime、Network 与 Telemetry 的信任边界。
---

Eveland 尽量减少能够跨越每条权限边界的组件数量。

## 认证边界

Invite-only 的 Dashboard 与 API 访问使用 Better Auth Session 与 Team Membership。公开 Agent 流量始终位于 Agent 自己的认证边界。Dashboard Login 永远不会成为 Agent Credential。

## 组件权限

- Agent Gateway 接收公开 Agent 流量，但没有 Source Tree、Telemetry Policy Data、Decrypted Secret 或 Runtime Controller。
- API 拥有需要认证的平台状态与加密能力，但没有宿主机 Runtime 权限。
- Worker 是唯一 Docker/systemd Controller，并且没有公开 Service Endpoint。
- Agent Unit 使用非特权用户和严格的 systemd Filesystem/Resource Control。

## 不受信任的 Build 与执行

项目依赖 Lifecycle Script 在文档规定的 Build Sandbox 内以非特权构建用户执行。Worker Secret 会从 Build Environment 移除。Prepared Release 获得 Eveland 的 bwrap Backend，使 Agent Execution 在没有 Docker/KVM 权限的情况下使用真实隔离 Workspace。完整的 Build 信任边界、Build 可见 `variable` Allowlist 与 `runtimeKind` 运行时切换警告见[安装宿主机 Worker](/zh/docs/production/worker)。

## Secret 生命周期

Secret 永远不会进入 Source Snapshot、Release Layer、Log、Telemetry Signal、Event、Fixture 或 Client Response。API 与 Worker 必须共享生产 Application Encryption Key；Agent Gateway 永远不会收到该 Key。

## 网络边界

只有 Agent Gateway 接收公开 Wildcard Agent Host。Raw Agent Port 只监听 Loopback，`/internal/*` 保持 Service Authentication 并从公开代理排除。Hostname 形态与 Wildcard 证书模型见[配置 Agent 流量](/zh/docs/production/networking)。

## Playground authentication Credential 边界

Playground 的 Route-auth Credential 既不是平台 Session Cookie，也不是 Agent Gateway 配置。API 拥有加密的 Playground authentication 配置，只为单次请求用 `APP_SECRET_KEY` 打开它，然后经私有的 `/internal/projects/:projectId/playground/eve/*` 路径发送带版本的 Credential Envelope。Agent Gateway 只在 `EVELAND_GATEWAY_SERVICE_TOKEN` 校验通过后接受该 Envelope，验证其 Authority 与 Header Policy，最后才应用 Credential，且永不持久化。始终把 `/internal/*` 从所有公开 Traefik Route 中排除。缺失 Envelope 时保留 Service-authenticated Loopback 行为仅为滚动升级兼容；当前 API 实例总是发送显式 Envelope。

`local-dev` 是唯一选择 Loopback Authority 的方法。`none`、Basic、Bearer、Vercel OIDC、Generic OIDC 与 Custom Header 都使用规范的 Project Hostname，因此 Eve 不会把公开形态的请求误认为本地开发。修改规范化后的 Playground authentication 方法或配置会递增其 Security Revision；未变化的重复保存不会。Playground authentication 的密码、Token 与 Custom Header 值绝不能复制进 Compose 文件、systemd Env 文件、Runtime Diagnostic、Log、Source Revision、Release、OTLP Signal 或浏览器 Payload。

## OIDC 网络策略

Generic OIDC 需要把 `${WEB_ORIGIN}/agent-auth/oidc/callback` 注册为精确 Redirect URI。Callback 页面由 Dashboard 拥有并经已认证的 API 完成；API 用 `APP_SECRET_KEY` 加密一次性十分钟 Transaction 与按 Principal 划分的 Access/Refresh Token。Confidential Client 的配置只存 Project Secret Reference，因此保存 `client_secret_basic` 或 `client_secret_post` 方法前先创建该 Secret。API 在 Preflight、Callback、Verification 与 Refresh 时都重新解析当前引用值；轮换 Secret 不会把它复制进 Playground authentication 配置。

只允许 API Egress 到批准的 OIDC Discovery、Authorization Metadata、JWKS、Token 与 UserInfo HTTPS 端点。应用层 URL Policy 拒绝 userinfo/fragment、非 HTTPS 端点、localhost、字面私有地址与重定向；网络层还必须防止 DNS Rebinding 以及解析到私有/链路本地目的地。绝不通过反向代理 Access Log 或 Runtime Diagnostic 暴露 OIDC Token、Authorization Code、State、Client Secret 或 PKCE Verifier。

显式的 Vercel OIDC 方法与 Eve Client 一致：解析配置的 Secret Reference，并同时在 `Authorization: Bearer` 与 `x-vercel-trusted-oidc-idp-token` 中发送 Token。Vercel OIDC Token 短时效；在过期前轮换被引用的 Secret。Eveland 永远不会根据 Vercel 部署、Agent 源码或 `401` 响应推断该方法。

## 外部身份（Eveland Identity）

外部已认证聊天使用独立的托管 Identity 边界。在 API 与 Worker 上设置同一个稳定公开的 `EVELAND_IDENTITY_ISSUER`，把 `EVELAND_IDENTITY_ALLOWED_ORIGINS` 设为精确的 EveChats 浏览器 Origin，并给 Worker 一个 Agent 可达的 `EVELAND_IDENTITY_JWKS_URL`（宿主机 systemd Agent 用 `http://127.0.0.1:17301/.well-known/jwks.json`）。在 System > Identity 中创建 Internal Provider 与精确的允许 Realm，注册 `eve-chats` Return Origin，并验证只读的 `/api/agent-catalog` 投影：它向所有调用方返回相同的可路由 `eveChannel` Project，是公开的，不按 Realm 过滤，也不配置 Agent Authorization。Worker 保留并注入 Issuer、JWKS URL 与 `EVELAND_PROJECT_ID`；Project Secret 与 Shared Agent Environment 无法覆盖它们。

绝不在 EveChats 或 Agent 配置中复用 `BETTER_AUTH_SECRET`、Better Auth Cookie、Playground authentication Credential 或 Provider Token。当 Agent 的 Route Auth 要求 Eveland Identity 时，其 `WWW-Authenticate` 响应标明 Eveland Login Continuation 与 Project Audience；浏览器跟随该 Continuation，获得短时效 Caller Token 后重试原请求。Agent Gateway 透明转发 Challenge 与 Credential；Agent 负责验证 Token，并继续承担业务 Authorization（包括 `403`）。

把 Eveland Identity 与浏览器聊天界面部署在同一 Schemeful Site 上，通常是同级 HTTPS 子域。独立的 `eveland_identity` Cookie 作用域为 `/api/identity`，只保护 Identity API；`/api/agent-catalog` 是公开的。该 Cookie 使用 `SameSite=Lax`，因此无关站点即使其精确 Origin 出现在 CORS Allowlist 中，也无法用它发起携带凭证的 Token 请求。

## Shared Agent Environment

单例的 Shared Agent Environment 以 AES-256-GCM 密文存储在 Postgres 中，使用同一个 `APP_SECRET_KEY`；不新增任何宿主机环境变量或 Compose Secret。只有管理员能修改它，它应用到每个 Agent Deployment。进程启动时 Worker 按 Shared Agent Environment < Project Secret < Eveland Reserved 的优先级解析，把最终值只写入 Docker 进程环境或 systemd Adapter 的 root 所有 `0600` `EnvironmentFile`，并把每个解密后的共享值加入 Runtime/Build Diagnostic Masking。这些值永远不会进入 Release、Build Layer、OTLP Signal、API Response、Dashboard Payload 或 Worker Configuration Snapshot。

修改或清空共享环境会为所有 `running`/`draining` Deployment 排队 `restart_deployment` Job，使旧进程无法保留过期或已删除的值；没有 Live Target 时，下一次 Deploy、Restart、Cold Activation 或 Schedule Activation 读取最新 Revision。不存在命名 Profile、Runtime Binding 或 Platform Secret Reference 兼容路径。API 与 Worker 的 `APP_SECRET_KEY` 必须继续保持一致。

## GitLab PAT 导入

GitLab PAT 导入在 API 与 Worker 上使用同一个 `APP_SECRET_KEY`；数据库只存按用户与规范化 HTTP Host 加密的 AES-256-GCM 密文。`git clone` 期间，Worker 通过 Git 的临时环境配置传递 Host-scoped Basic Authorization Header——Token 永远不会出现在 argv、仓库 URL、`.git/config`、Job/Status 响应或日志中。只有一次完整源码导入成功后，Credential 才会提升为用户的已保存设置。要求 PAT 设置过期时间并使用最小的 `read_repository` Scope；泄露的 Token 在 GitLab 中吊销，并在 Settings 里删除其 Host 条目。SSH/SCP 导入继续使用 Worker 宿主机现有的 SSH 配置，不消费 PAT。

## 深入参考

- [身份架构设计决策](/zh/docs/reference/design/identity)：三条独立信任边界与 Caller Token 机制
- [Agent 身份行为契约](/zh/docs/reference/identity)：三种 Provider 模式、Token 规范与 `evelandIdentity()`
- [Agent 环境行为契约](/zh/docs/reference/agent-environment)：Project Secret、Shared Environment 与保留变量优先级
- [安装宿主机 Worker](/zh/docs/production/worker)：构建 Sandbox、非特权用户与权限隔离实操
