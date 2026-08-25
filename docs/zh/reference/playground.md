---
title: Playground
description: Playground transport、会话生命周期、认证方法矩阵与受管 Eve Connection 验证的行为参考。
---

Playground 用于直接测试当前 Deployment。本页是它的行为契约：transport 与会话生命周期、八种客户端认证方法、OIDC 客户端流程，以及受管 Eve Connection 的验证矩阵。三类凭据（Eve Connection、运行时注入值、Playground 客户端凭据）的区分见[密钥与 Connection](/zh/docs/agents/secrets-connections)；凭据信封与网络边界的运维侧规则见[安全模型](/zh/docs/operations/security)。

## Transport 与会话生命周期

用户输入消息后，Dashboard 使用 Eve canonical session protocol，经 API 和仅内部可达、带 service credential 的 Agent Gateway Playground path 请求当前 Deployment。对话内容、reasoning、tool 调用与人工输入都按 NDJSON 增量流式展示。公开 Agent 流量使用 canonical stable/preview Host；Agent Gateway 不替代 Agent 自己的 Authorization/Cookie 认证。

每次打开或刷新 Playground 都从空白状态创建一个新的 Eve Session；同一页面内的后续消息、HITL 回答和恢复后的 tool 结果继续使用该 Session，不提供历史会话切换或页内会话重置入口。离开页面时通过 keepalive request best-effort reset，页面退出不能依赖响应完成。平台为这次页面会话创建一个可在 Sessions 页面查看的 Session 记录（`trigger = playground`），但 Playground transport 不替代 Eveland 私有 OTLP 信号的权威观测路径。

Dashboard 将 Playground 呈现为全页聊天界面。Transcript 参与页面的自然滚动，不再形成嵌套的滚动面板；Composer 则保持在视口底部可用。其紧凑操作可直接打开附件选择器与 Playground authentication 设置。

Playground 中可查看当前 Session 的：对话内容；实时 reasoning / thinking（原始 reasoning 不由 Playground 持久化）；tool 调用与返回结果；错误；HITL（确认/拒绝、选项、自由文本和外部授权提示）；当前 turn 的图片、PDF、文本和代码附件。

Playground 每次最多接受 4 个附件，单文件不超过 5 MiB、合计不超过 10 MiB；不接受压缩包或可执行文件。附件以 data URL 传给 Eve，原始文件不由 Playground transport 持久化。

生成中的 turn 可以停止。停止必须使用 canonical cancel route 请求服务器协作取消，并保持当前 NDJSON stream，直到观察到 `turn.cancelled` 和后续 session boundary；不能只关闭浏览器 stream。前端 binding 使用异步 `cancel()`，它会等待准确的 durable turn id，且在 settlement 前保持 stream attached；平台不得退回已移除的同步 `stop()`。Client 在 transient disconnect 后从最后一个 absolute cursor 自动重连，Eveland 不依赖或暴露已移除的 `maxReconnectAttempts`；Caller 可显式关闭自动重连，Playground 保留默认重连策略。NDJSON stream 打开时可能先发送空白字节，Agent Gateway 必须立即透传，API monitor 和任何平台 parser 必须忽略空行。取消 turn 时，Transcript 中仍为 pending 的 tool/subagent 调用显示为 cancelled。

Client 可以通过 `follow: false` 做有界 Catch-up Read：请求使用 `includeTailIndex=1`，Agent 返回 `x-eve-stream-tail-index`。Dashboard rewrite、API Playground proxy、内部与公开 Agent Gateway 必须原样保留该 query、响应 header 与 NDJSON body。Playground 自身继续使用默认 Live Follow，不停止等待当前 turn 的后续事件。

## Playground authentication

每个受管 Project 最多有一套 Playground authentication 配置。它是 Playground 调用 Agent 的客户端配置，不是 Project、Deployment、Eve Connection 或平台登录 Session。用户必须在 Playground authentication 设置中显式选择客户端方法；平台不得从 Eve verifier 名称、源码 import、401 或 `WWW-Authenticate` 猜测 credential acquisition。Eveland member id 只作为 Caller Principal 隔离未来的 delegated credential，不发送到 Agent，也不与 Agent verifier 建立的 Caller 做隐式映射。

当前通用方法包括：

- `local-dev`：不发送 credential，并且用 loopback Host 调用 Agent。**它对当前窗口内的任何 Agent 都不再构成认证**——`localDev()` 只看进程是否 `eve dev`，而 Agent 在 Eveland 上以 `eve start` 运行，因此不放行任何请求。该方法只剩历史含义；这类项目必须改用 `eveland-identity` 或 Agent 自有的 AuthFn。Agent Gateway"绝不为公网流量把 Host 改写成 loopback"的不变量与本条无关，且必须保留；
- `none`：不发送 credential，但仍用 Project 的 canonical Agent Host；
- `eveland-identity`：发送 Eveland 签发的 Caller Token，让 Agent 的 `evelandIdentity()` 看到与真实调用方一致的身份。无配置字段：token 代表哪个 Principal 取决于实例的 Identity Provider——Open 模式用共享 Principal，Eveland Internal 用当前登录的平台用户（因此按 Caller 而非按 Connection 缓存），OIDC 暂不支持；
- `basic`：发送 HTTP Basic username 和延迟解析的 password Secret reference；
- `bearer`：发送延迟解析的外部签发 Bearer token Secret reference；
- `vercel-oidc`：镜像 Eve Client，同时发送 Vercel OIDC Bearer 与 trusted deployment header；
- `oidc`：每个 Caller Principal 独立通过 Authorization Code + PKCE 获取、验证并刷新 Bearer token；
- `headers`：发送显式配置、经过保留 Header policy 校验的 custom credential headers。

`vercel-oidc` 是独立的显式客户端 provider，不是 generic `oidc` 的 provider-name 分支。它按 Eve Client `ClientAuth.vercelOidc` 的 wire behavior 发送同一个短期 token 到 `Authorization: Bearer` 和 `x-vercel-trusted-oidc-idp-token`，从而同时穿过 Vercel Deployment Protection 并到达 Agent verifier。Playground authentication 只保存 token Secret reference/configured 状态；平台不从 Agent 源码或 Vercel 环境自动切换方法。

通用 `oidc` 方法只使用协议级配置：HTTPS issuer、client id、scope、可选 audience 及其 `resource`/`audience` 参数模式、显式 token endpoint client authentication、附加 authorization parameters，以及 `eve-jwt` 或 `userinfo` access-token verification。confidential client secret 通过 Project Secret 引用，不能进入 Playground authentication browser payload。`eve-jwt` 必须绑定已配置的 issuer/audience；`userinfo` 必须让 UserInfo `sub` 与已验证 ID Token `sub` 一致。Provider 名称不能改变 scope、prompt、client authentication 或 verification 行为。

OIDC interaction 使用 Dashboard-owned callback page 和经过平台登录认证的 API callback。state、nonce、PKCE verifier、Caller Principal、authentication revision 与 return path 保存在十分钟、一次性消费、加密的 transaction 中；过期 transaction 有实际清理路径。access/refresh token 按 Caller Principal 隔离加密保存，只有 JWT/UserInfo 验证成功后才能发送给 Agent。暂时 verification failure 保持 pending，永久 token rejection 不激活 credential。refresh 使用进程内 singleflight 和 Postgres lease/rotation fencing；过期 lease writer 不能完成更新。

缺少 OIDC credential 的第一轮 Playground turn 先保存在当前 browser session，跳转授权，callback 完成后 claim 并仅重发一次；授权前不得创建 Agent request。已有 credential 收到第一个 401 时最多 refresh 并重发一次，第二个 401 不产生第三个 Agent request；403 不 refresh。Caller Principal 是 Eveland member id 的隔离键，可以与 ID Token `sub`、access-token subject 和 Agent Caller 完全不同。

## 凭据存储与请求路径

Playground authentication 的 normalized config 使用 `APP_SECRET_KEY` 派生用途密钥并以 AES-256-GCM 保存，AAD 绑定 authentication configuration id、opaque method 和 security revision。API/Dashboard 只返回 descriptor 与脱敏 configured 状态，不返回 password、token 或 custom Header value。只有 method 或 normalized config 发生语义变化时 security revision 才递增；旧 revision credential 不再命中新请求。

API 为每次 initial、continuation、cancel 和 stream/reconnect 重新解析当前 credential，并通过 service-authenticated internal path 发送严格校验的 versioned envelope。Agent Gateway 只在验证 service token 后读取 envelope：`local-dev` 构造 loopback Host，其他方法构造 canonical Project Host，最后写入 credential Header。Agent Gateway 不保存、解密或刷新 provider credential；public path 的 Authorization、Cookie、Origin、Host、abort 与 NDJSON streaming 继续透明转发。

## 受管 Eve Connection

Eveland 不增加独立的 Connections 配置页，也不接管 Eve 的 Connection 定义。项目源码中的官方 Eve Connection 随 Source Revision 构建并随 Release 部署；当前受管集成明确验证：

- `defineMcpClientConnection` 与 `defineOpenAPIConnection`；
- 根 Agent 与目录型 Subagent 的 Connection；
- `auth.getToken()` 在运行时读取 Project Secret，并以 app-scoped Bearer credential 调用外部服务；
- deploy、restart 和新 Release 后继续可用，且 credential 不进入 Build Log 或 Release summary。

Connection URL、inline OpenAPI spec 与模块结构仍是源码/构建输入；Project Secret 只在运行时注入，不能在 build 时读取。Vercel Connect 是项目可以自行采用的外部 credential helper，不是 Eveland 托管 Connection 的前置条件，也不要求 Eveland operator 或项目拥有 Vercel account。self-hosted interactive user authorization 尚未纳入端到端支持矩阵；Connection marketplace 仍是非目标。

## 深入参考

- [密钥、Connection 与 Playground 认证](/zh/docs/agents/secrets-connections)：面向开发者的凭据配置指引
- [安全模型](/zh/docs/operations/security)：Playground 凭证信封、安全版本号与网络 Egress 策略
- [Agent Gateway 不变量](/zh/docs/reference/design/gateway)：`/internal/*` 路径的特权隔离与数据面边界
- [Agent 身份](/zh/docs/reference/identity)：Eveland Identity、OIDC 与 Caller Token 体系
