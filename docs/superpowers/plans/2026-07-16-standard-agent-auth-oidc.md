# Eveland 标准 Agent Auth 与 OIDC 实施计划

**日期：** 2026-07-16
**状态：** 工作树实现与自动化验证完成；真实 Postgres、真实 IdP 和 Linux 拓扑验收待运行
`docs/superpowers/plans/2026-07-15-standard-agent-auth-oidc.md`
**Eve 基线：** `>=0.24.0 <0.25.0`，当前 lockfile 为 `eve@0.24.4`

## 1. 目标

让 Eveland Playground 像 EveChats 一样，以 Agent Connection 连接 Eve Agent 并进行
对话。Agent 使用 OIDC route auth 时，用户发送第一条消息后，Playground 收到结构化的
`interaction_required`，引导用户到 IdP 授权；callback 返回后重发尚未被 Agent 接受的
第一条消息，之后 continuation 与 stream 重连自动携带和刷新凭证。

认证能力建成获取方式注册表和 provider 协议，使新增 Basic、静态 Bearer、自定义
header、client credentials 或 Vercel OIDC 时，不需要修改 Playground 的消息、session、
continuation、stream 主流程。Eveland 登录只保护控制面并为 delegated credential 提供
caller-principal 隔离键；Agent Caller 完全由 Agent 自己的 route-auth policy 建立。

公开 Agent Gateway 仍是透明数据平面：它不成为 IdP，不替换公开调用者的
`Authorization`、Cookie 或 Origin，也不把 Eveland 登录自动变成公开 Agent 凭证。

## 2. 现状与问题

当前 Playground 链路是：

```text
Browser Eve Client
  -> authenticated API /projects/:projectId/playground/eve/*
  -> service-authenticated Gateway /internal/projects/:projectId/playground/eve/*
  -> Agent private port with Host: localhost:<port>
```

最后一步故意使用 loopback Host，以便 Eve 的 `localDev()` 接受内部 Playground。
这个 privileged path 绕过了真实 route auth，因此不能表现 OIDC、Basic、JWT 或自定义
header 的客户端体验。

Eve 官方定义了两个独立系统：

- **Route auth（入站）**：客户端调用 Agent 的 `/eve/v1/session*`，在任何模型工作前
  接受或拒绝请求。本计划处理的 OIDC 属于这里。
- **Tool and connection auth（出站）**：Agent 在会话已经被接受后调用外部 MCP/API，
  通过事件流发出 `authorization.required`。Playground 现有渲染继续处理它。

本文的 **Agent Connection** 是 Playground/EveChats 保存的“目标 Eve Agent + route-auth
获取方式”客户端关系，不是 Eve Agent 源码中 `agent/connections/*` 的 **Eve Connection**。
后者属于 Tool and connection auth，明确不在本实现范围。

## 3. 范围

### 3.1 第一阶段必须交付

- 每个 Agent Connection 显式声明 auth method 与配置；新项目导入时由团队成员选择获取方式
  （可选择 `local-dev`），不解析 Agent 源码来猜测。现有项目首次解析 connection 时兼容创建
  `local-dev` 配置，保持行为。
  Eveland Playground 为当前受管 Agent 解析一个稳定的 connection。
- server-side method 注册表、配置 schema、credential scope、provider 和交互路由描述；
  Playground 不包含按 method 分支的 `switch`。
- 静态获取方式：
  - `local-dev`：保留现有 privileged loopback Playground；
  - `none`：canonical Host、无凭证；
  - `basic`：`Authorization: Basic ...`；
  - `bearer`：覆盖静态 JWT、静态 OIDC access token 等 Bearer 场景；
  - `headers`：覆盖 Eve custom `AuthFn` 的 header 形态。
- 交互式 `oidc`：Authorization Code、discovery、PKCE S256、state、nonce、授权码交换、
  token 加密存储、access token 激活校验、静默 refresh、重新授权。
- connection auth 配置与 OIDC token 的 AES-256-GCM 服务端加密；密文 AAD 绑定
  Agent Connection、method、security revision、credential scope/subject 和 key。
- 第一条消息触发 OIDC 授权：原始 turn 在浏览器保持 pending，route auth 完成前 Agent
  不创建 Eve Session、不执行模型；callback 后只重发一次。
- 每个受保护请求动态解析凭证；initial session、continuation 与 stream 重连走同一
  `request()` 管道。
- 第一次 401 最多恢复并重发一次；第二次 401 不发第三次请求；403 永不 refresh。
- 带 `securityRevision`、`rotationSeq`、lease id 的 refresh fencing，避免并发 refresh
  token rotation 相互作废。
- OIDC callback 和每次 refresh 得到的 access token 均用 Eve 公开的 `verifyOidc`
  按同一 issuer/audience 激活；未验证 token 永不发送给 Agent。
- Playground 的 Connection 设置：选择 method、填写配置、查看只读状态；正常授权入口由
  第一次消息或凭证永久失效后的 `interaction_required` 提供，而不是要求先去 Project
  设置页面手动授权。
- API、Gateway、Web、数据库迁移、环境样例、产品/部署文档和自动化测试形成完整纵向切片。

### 3.2 明确不在第一阶段

- 不自动从 `WWW-Authenticate` 推断 method；verifier 名不等于凭证获取方式。
- 不实现 OIDC client credentials、token exchange、device flow、DPoP、mTLS、SigV4 或
  Vercel OIDC resolver；注册表和 scope 模型为它们预留扩展点。
- 不替 Agent 实现最终用户注册、登录或 session ownership；不把 Eveland member 的
  id/email/role 或 Better Auth session 转换成 Agent Caller。
- 不实现 Eve Connection Auth 客户端；只继续渲染 Agent 事件流中的 connection OAuth
  challenge。
- 不承诺应用层 URL 检查可以替代生产网络层 egress policy。

## 4. 已确定的架构决策

### 4.1 Agent Connection 是客户端目标，不是 Project，也不是 Eve Connection

保留参考设计的 `agentConnectionId`。Agent Connection 是稳定的客户端配置快照，包含
目标 Agent 地址、auth method、加密配置和 `securityRevision`。Playground 页面刷新会创建
新对话，但复用同一 Agent Connection 和仍然有效的 credential。

Eveland 当前只连接自己管理的 Agent，因此由一个 adapter 根据页面上下文解析或创建
Agent Connection，并把它关联到受管 stable route。Project/Deployment 只负责生命周期、
权限和 Gateway 路由：

```text
Project -> managed Agent route -> Agent Connection -> AgentAuthModule
```

Agent Auth 的配置、凭证、授权事务和 provider API 全部只使用 `agentConnectionId`，不以
`projectId` 作为凭证 scope。Project 删除可以级联删除它拥有的 connection，但这只是资源
生命周期关系，不是 auth 语义。未来连接外部 Eve Agent 时可复用同一模块。

配置来源必须显式：当前 Eve 的 compiled manifest 与 `eve info --json` 只序列化 channel
的 method/path 等路由信息，不序列化 `eveChannel({ auth })`。`AuthFn` 可以是条件分支、环境
变量、多个 verifier 的有序数组或完全自定义函数，静态源码解析无法可靠还原运行时策略；
而且即使识别到 Agent 使用 `oidc()`，也不能决定客户端应采用 authorization code、client
credentials、token exchange 还是静态 Bearer。因此：

- 新项目导入表单要求团队成员从 method registry 选择 Agent access method，并提交该 method
  的客户端配置；这是创建 Agent Connection 的输入，不是 Project credential scope。
- 已有项目由兼容 adapter 首次解析为 `local-dev`；团队成员可在 Playground 的 Connection
  设置中修改。
- 未来可以让部署后的 `/eve/v1/info` readiness 只诊断已配置 method，不反向修改配置。
- `WWW-Authenticate` 与未来 Eve 可序列化的 auth metadata 最多作为预填/诊断提示，必须经
  用户确认；源码 AST/正则解析不进入正确性路径。
- 如果导入时未形成有效配置，首条消息返回 `configuration_required` 并保留 pending turn，
  不把泛化的 `Bearer` challenge 猜成 OIDC。

### 4.2 Caller Principal 与 Agent Caller 分离

| 概念 | 来源 | 用途 | 是否发送给 Agent |
| --- | --- | --- | --- |
| Caller Principal | Agent 客户端自身的登录/匿名会话；当前 Eveland 使用 member id | 隔离 delegated credential | 否 |
| Agent Caller | OIDC `iss/sub`、静态 token、Basic 或 custom AuthFn 的结果 | Agent route auth 建立的调用者 | 只发送 credential，由 Agent 解析 |

OIDC authorize/callback 必须绑定同一个 Caller Principal，目的是阻止一个 Playground
调用者窃取另一个调用者的 grant；这不表示 OIDC `sub` 应等于 Better Auth user id/email。
系统不得比较、推断或自动链接这两个身份。

`credentialScope="connection"` 表示静态或机器 credential 由 Agent Connection 共享；
`credentialScope="principal"` 表示交互式 credential 由
`(agentConnectionId, callerPrincipalId)` 隔离。这里的 `connection` 与 Eve Connection
Auth 无关。

### 4.3 获取方式与 Agent verifier 分离

method 表示“Eveland 如何获得并维护出站凭证”，不表示 Agent 使用了哪个 verifier：

| method | 可覆盖的 Eve route auth | scope | 线格式 |
| --- | --- | --- | --- |
| `local-dev` | `localDev()` | connection | loopback Host，无凭证 |
| `none` | `none()` | connection | canonical Host，无凭证 |
| `basic` | `httpBasic()` | connection | Basic header |
| `bearer` | `jwtHmac()` / `jwtEcdsa()` / `oidc()` 的静态 token | connection | Bearer header |
| `headers` | custom `AuthFn` 的 header 形态 | connection | 自定义 headers |
| `oidc` | `oidc()` 的交互式授权（Authorization Code + PKCE） | principal | Bearer header |

未来 `oidc-client-credentials` 和 `vercel-oidc` 是新的 provider registration，而不是
在现有 OIDC provider 内继续增加模式分支。

OIDC 首条消息的时序固定为：

1. 团队成员已在导入或 Connection 设置中为 Agent Connection 显式配置
   `oidc` 及 issuer/client/audience；首条消息负责触发用户授权，不负责
   从 Agent 自动发现这些配置。
2. Playground 暂存首条 turn 并请求创建 session；`AgentAuthModule` 发现当前
   `(agentConnectionId, callerPrincipalId)` 没有 credential，直接返回
   `interaction_required`，此时不请求 Agent upstream。
3. 用户完成 authorize/callback；provider 将通过验证的 token 写入上述 principal scope。
4. Playground 返回原页面后只重发一次 pending turn；Agent 的 Route Auth 验证 Bearer
   credential 并建立自己的 Agent Caller，随后模型才开始工作。
5. 会话内如果 Agent 的工具调用另行产生 `authorization.required`，那是 Eve Connection
   Auth 事件，只进入消息事件渲染，不进入本流程。

### 4.4 一个深模块，调用方只依赖稳定接口

新增 `packages/agent-auth`，依赖 `@eveland/core` 与 `@eveland/db`。API 负责组合模块与
HTTP 路由，Gateway 不导入 provider 或解密逻辑。

```ts
type AgentAuthTarget = {
  agentConnectionId: string;
  callerPrincipalId: string;
};

type AgentRequestTarget = {
  pathname: string;
  searchParams?: Record<string, string>;
};

type AgentRequestInit = {
  method?: "GET" | "POST";
  body?: Uint8Array | null;
  contentType?: string | null;
  accept?: string | null;
  signal?: AbortSignal;
};

interface AgentAuthModule {
  request(
    target: AgentAuthTarget,
    request: AgentRequestTarget,
    init: AgentRequestInit,
    interaction?: { returnPath: string },
  ): Promise<Response | AgentAuthFailure>;

  status(
    target: AgentAuthTarget,
    interaction?: { returnPath: string },
  ): Promise<AgentAuthStatus>;
}
```

配置管理和交互式路由使用同一个 registry，但暴露单独的 configuration/interaction facade；
Playground proxy 只拿到 `request()` / `status()`，不能直接访问 provider、token payload
或解密配置。

模块把 `callerPrincipalId` 仅用于选择 principal-scoped credential。transport envelope
只包含物化后的 Agent credential，绝不包含 Eveland member id/email/role；Gateway 和
Agent 都不能从请求中观察或重建 Caller Principal。

### 4.5 Gateway 保持数据平面边界

API 侧模块解析凭证后，通过现有 service-authenticated internal Playground path 传递
一个版本化、严格校验的 request credential envelope。Gateway 只有在 service token
验证成功后才解码 envelope，并执行：

1. `local-dev` 使用现有 loopback authority；
2. 其他 method 使用 Agent Connection target 的 canonical Host；
3. 只复制 Playground 所需的 content type / accept；
4. 在业务 header 之后写入 registry 物化的凭证 header；
5. 拒绝 `host`、hop-by-hop、`forwarded`、`x-forwarded-*`、`proxy-*`、
   `x-eveland-*`、`content-length` 等危险自定义 header；
6. 永不把浏览器 Cookie 或 Authorization 当作 Agent credential；
7. 永不注入 Caller Principal 的 id/email/role 或其他客户端身份 header/claim。

公网 `app.all("*")` 继续删除外部伪造的 `X-Eveland-*`，所以外部调用者不能构造
trusted envelope。Gateway 不持久化、不 refresh、不解密 OIDC token；token 只在一次
内部请求的内存中经过它。

### 4.6 配置与安全版本

新增 Agent Connection 配置记录：

```text
agent_connections
  id                     PK
  target_kind            managed_route（未来可扩展 external_url）
  target_ref             当前为受管 route id
  base_url
  method
  config_encrypted
  security_revision      starts at 1
  created_at
  updated_at
```

- 现有 Playground 的受管 Agent 由兼容 adapter 按需创建 `local-dev` revision 1 connection；
  新导入项目在创建时显式写入 connection。
- method 或归一化配置发生语义变化时，在一个事务内 `security_revision + 1`。
- target URL 或 route identity 发生安全语义变化时同样递增 revision。
- 仅重新加密、不改变语义时不递增 revision。
- 旧 revision 的凭证与未完成授权事务立即失去命中资格，异步清理可以后置。
- API 返回的配置只包含非 secret 字段和 `secretConfigured` 标记；password、token、
  client secret 和 custom header value 永不回传浏览器。

`config_encrypted` 使用带版本前缀的 AES-256-GCM envelope。现有 `APP_SECRET_KEY` 仍是
部署密钥，但 Agent auth 使用独立的用途派生和 AAD，不能把 Project Secret 密文替换到
Agent auth 表，也不能跨 connection/method/revision 替换。

### 4.7 获取型凭证与 refresh fencing

新增通用表：

```text
agent_auth_credentials
  agent_connection_id
  security_revision
  auth_method
  credential_scope       connection | principal
  scope_subject          connection 为 ""；principal 为 caller principal id
  credential_key         default ""
  payload_encrypted
  expires_at
  rotation_seq
  refresh_owner
  refresh_lease_id
  refresh_lease_until
  created_at
  updated_at
  UNIQUE(agent_connection_id, security_revision, auth_method,
         credential_scope, scope_subject, credential_key)
```

数据库 check 强制 scope shape、非负 revision/rotation。principal-scoped 的
`scope_subject` 是客户端隔离键，不是 Agent principal。OIDC payload 另行记录 Agent
已验证的 issuer/subject，是 provider 私有的状态 union：

```ts
type OidcCredentialPayload =
  | {
      state: "active";
      accessToken: string;
      refreshToken?: string;
      agentIssuer: string;
      agentSubject: string;
      idTokenIssuer: string;
      idTokenSubject: string;
      obtainedAt: string;
    }
  | {
      state: "pending_verification";
      candidateAccessToken: string;
      refreshToken?: string;
      agentIssuer?: string;
      agentSubject?: string;
      idTokenIssuer: string;
      idTokenSubject: string;
      obtainedAt: string;
    };
```

refresh 顺序固定为：进程内 singleflight → 带当前 security/rotation 版本抢数据库租约 →
抢到后重读 → 调 token endpoint → 以 owner、lease id、security revision、rotation seq
四重条件 CAS 写入并递增 rotation。未抢到者不调用 IdP，只等待并重读。token endpoint
timeout 必须短于 lease TTL。任何失败释放/删除也必须带同样 fencing，旧持有者不能影响
新版凭证。

### 4.8 OIDC 授权事务

新增 state-keyed 一次性事务表。数据库只存 state hash；密封 payload 绑定：

```text
agentConnectionId, securityRevision, callerPrincipalId, authMethod,
PKCE verifier, nonce, redirectUri, returnPath, expiresAt
```

- state 至少 256 bit，事务十分钟过期并在 callback 原子消费；多标签页互不覆盖。
- authorize 与 callback 都要求当前 Caller Principal，且必须与事务的
  `callerPrincipalId` 相同；这个检查只保护 delegated credential，不与 OIDC `sub` 比较。
- `returnPath` 由 API 从当前 Playground connection 推导并限制在同源 Playground 路径，
  不接受任意外链。
- callback 写凭证前重新确认 Agent Connection 当前 revision；配置或 target 已变则拒绝
  旧 callback。
- 浏览器可见 callback 使用 Web 同源 rewrite：
  `${WEB_ORIGIN}/api/eveland/agent-auth/callback/:method`。

### 4.9 OIDC provider 行为

配置：

```ts
type OidcAuthorizationCodeConfig = {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?:
    | "client_secret_basic"
    | "client_secret_post"
    | "none";
  audience: string;
  audienceMode?: "resource" | "audience" | "both";
  scopes?: string[];
  promptConsent?: boolean;
};
```

- 使用 `openid-client` 当前 v6 API，不手写 authorization code/OIDC 协议。
- 无条件使用 PKCE S256 与 nonce。
- scopes 归一化后必须包含 `openid`；默认包含 `offline_access`，默认
  `prompt=consent`。显式移除 `offline_access` 表示接受 access token 到期后重新授权。
- 保存时做 discovery 预检：issuer/endpoint URL policy、必需 endpoint、所选 token
  endpoint auth method、受众形式。
- callback 用 `openid-client` 验证 state、nonce、PKCE 和 ID token，并将其
  `iss/sub` 独立保存为客户端登录身份；refresh response 没有新 ID token 时保留原身份，
  有时必须验证并比较 `iss/sub/aud`。
- Agent `iss/sub` 来自 Eve `verifyOidc` 验证后的 access token。ID Token 与 access token
  可以为同一资源所有者使用不同的 subject 字符串，不能互相比较或替代；二者都不与
  Caller Principal 或 Eveland 账号 email 比较。发送给 Agent 的只有 access token，
  Agent 自己的 `oidc()` 或 custom verifier 决定最终 `principalId` / `principalType`。
- callback 和每次 refresh 的 access token 先调用 Eve `verifyOidc(token,
  { issuer, audiences: [audience] })`。成功才写 `active`。
- discovery/JWKS 临时不可用时保存 `pending_verification`、ID Token 身份和已经轮换的新
  refresh token；refresh 产生的 pending 还保存原 Agent 身份以阻止 access-token 身份突变。
  后续请求只重试验证，不重复 refresh。确认签名、issuer、audience 或 token 格式不兼容时
  返回 `configuration_invalid`，永不向 Agent 发送 candidate。
- refresh response 有新 refresh token 时替换；没有时保留旧 token。
- `invalid_grant` 等永久错误按 fencing 作废匹配版本并要求重新授权；网络/5xx 保留 token，
  返回 `provider_unavailable`。

### 4.10 401、403 与错误契约

```ts
type AgentAuthFailure = {
  code:
    | "configuration_required"
    | "interaction_required"
    | "credential_rejected"
    | "forbidden"
    | "configuration_invalid"
    | "provider_unavailable"
    | "upstream_unavailable"
    | "retry_required";
  method: string;
  message: string;
  interaction?: { type: "redirect"; url: string };
};
```

| code | HTTP | 行为 |
| --- | --- | --- |
| `configuration_required` | 409 | 团队成员完成 Agent Connection 配置，保留 pending turn |
| `interaction_required` | 401 | Web 展示授权按钮 |
| `credential_rejected` | 401 | 静态凭证需修改 |
| `forbidden` | 403 | 不 refresh、不重试 |
| `configuration_invalid` | 422 | 修改 Agent Connection 配置 |
| `provider_unavailable` | 503 | 保留凭证，稍后重试 |
| `upstream_unavailable` | 502 | Agent/Gateway 不可达 |
| `retry_required` | 409 | 并发新版被保留，调用方可重发整个请求 |

请求管道：

```text
same-revision load config + credential
  -> provider.getCredential()
  -> trusted Gateway transport
  -> 401: recoverUnauthorized(rejectedVersion, attempt=0)
       -> getCredential again -> resend once
       -> second 401: terminal recovery(attempt=1), never third request
  -> 403: forbidden, no provider recovery
  -> other response: return unchanged
```

第二次 401 时，当前版本仍等于被拒版本则只作废该版本；已存在并发新版本则保留新版并
返回 `retry_required`。AbortSignal 原样传播，不归一化成 upstream error。

## 5. 出站安全策略

- Playground target 只接受 allowlist 中的 canonical Eve pathname；动态 session id 独立
  `encodeURIComponent`，query 只通过 `URLSearchParams` 传递。
- OIDC issuer 禁止 userinfo/query/hash；production 默认只允许 HTTPS，development 可通过
  明确配置允许本地 HTTP mock。
- discovery、authorization、token、JWKS endpoint 分别执行 URL policy。应用层解析 DNS
  并拒绝 loopback、link-local、云 metadata 与未授权私网地址；所有 redirect 手动处理并
  对新目标重新校验。
- production 部署文档必须要求网络层 egress policy，覆盖 DNS rebinding/TOCTOU 以及库
  内部 fetch；应用层检查不宣称消除该窗口。
- 自定义 headers 拒绝 hop-by-hop、Host、Content-Length、Cookie、Authorization、
  `Proxy-*`、`Forwarded`、`X-Forwarded-*` 和 `X-Eveland-*`。Basic/Bearer 使用专有 method，
  不能借 headers 绕过校验。
- Gateway 到 Agent 使用 `redirect: manual`；任何 3xx 原样返回，凭证不跟随 Location。
- token、client secret、password、自定义 header value 不进日志、错误响应、observer
  envelope、fixture snapshot 或浏览器 payload。

## 6. API 与 Web 产品面

### 6.1 控制面 API

建议路由：

```text
GET /agent-auth/methods
GET /projects/:projectId/playground/connection
GET /agent-connections/:agentConnectionId
PUT /agent-connections/:agentConnectionId
GET /agent-connections/:agentConnectionId/auth/status
GET /agent-connections/:agentConnectionId/auth/interactions/:method/start
GET /agent-auth/callback/:method
```

第一个路由把 Eveland 页面上下文适配成 Agent Connection；其余 Agent Auth 接口不接收
`projectId`。所有路由都在现有控制面 session 边界内。generic `:method` 路由只查 registry
并委托 registration 的 interaction handler，不包含 OIDC switch。callback 依靠
SameSite=Lax cookie 绑定当前 Caller Principal；没有有效客户端 session 或 principal
不匹配时 fail closed。这里不验证 Caller Principal 与 OIDC 账号是否相同。

`PUT` 对 OIDC 执行 discovery preflight 后再提交 config/revision。secret 字段采用 write-only
语义；同 method 更新时未提供的新 secret 可显式选择保留已有值，不允许空字符串意外清除。

### 6.2 Web

- 新项目导入表单加入 registry-driven Agent access method 配置。配置动作沿用团队成员的项目管理权限；
  它只创建 connection，不代表执行 OIDC 用户授权。
- Playground 加入 Connection 设置入口，从 server API 读取 method descriptors、redacted
  config 和当前 Caller Principal 的只读状态；不新增独立的 Project Agent Auth 页面。
- 表单由 descriptor 驱动公共字段布局；provider-specific 高级字段可以由 registration 的
  serializable descriptor 声明，消息发送流程不能判断 method。
- 用户提交第一条消息时，浏览器先把 turn 作为 pending state 保存，然后发起 canonical
  session request。
- `interaction_required` 不作为 Eve stream event 伪造进消息历史；Playground 在请求层显示
  Route Auth 授权卡片。用户进入同源 interaction URL 完成授权后返回原 Playground，状态
  变为 available，客户端只重发一次 pending turn。
- route auth 成功前 Agent 没有接受 initial request，不创建 Eve Session、不执行模型；重发
  成功后才进入既有 continuation/stream 流程。
- refresh 永久失效时复用同一 pending-turn/interaction 流程；401 自动 refresh 成功则用户
  无感。
- Agent 在已接受 session 内发出的 `authorization.required` 仍由现有
  `EveAuthorizationPart` 渲染，明确标为 Connection Auth，不能触发 Route Auth provider。
- OIDC status 只返回不含 token 的凭证可用性；未来若显示 Agent issuer/subject，必须明确
  标注为 Agent identity，且不能暗示它与 Caller Principal 对应。
- 浏览器永远不收到 access/refresh token 或静态 secret。

## 7. TDD seams（实施前需确认）

根据仓库 TDD 规则，测试只写在以下已提议的公共 seam；收到确认前不写测试代码。

### Seam A — `AgentAuthModule.request()` / `status()`

从模块唯一业务接口观察：状态只读、每请求动态凭证、header 物化结果、401 单次恢复、
第二次 401 终态、403、AbortSignal、结构化错误。IdP 和 Gateway transport 是系统边界，
使用脚本化 fake；不 mock 自己的 provider 内部方法来断言调用顺序。

### Seam B — `Store` Agent auth 方法

同一组 contract tests 跑 memory store 与 Postgres store，观察 config revision、credential
CAS/lease、transaction 单次消费和 Agent Connection 删除级联。跨实例 refresh、lease
expiry、callback-vs-refresh 竞态必须用真实 Postgres integration test，不能用内存实现证明。

### Seam C — 控制面 HTTP API

通过 Hono `app.request()` 观察 method/config/status/start/callback 和 Playground 响应；
使用与 OIDC subject 完全不同的 Caller Principal、进程内 OIDC mock server 与 fake
Gateway transport。断言浏览器响应不泄漏 secret/token，principal scope 和 callback
revision 绑定正确，且任何 Agent 请求都不出现客户端身份。

### Seam D — Gateway HTTP 边界

通过 Gateway Hono app 和真实本地 upstream HTTP server 观察：internal service auth、trusted
envelope、canonical vs loopback Host、Agent header 最后写入、stream/query/abort、public
header injection 防护，以及公开请求原有 Authorization/Cookie 透明性不回归。

### Seam E — Web 用户流程

通过 client API/pure form model 和现有页面结构测试观察：导航、redacted 配置渲染、method
切换、第一条消息 pending、Route Auth interaction、callback 后 exactly-once resend，以及
Connection Auth stream event 仍走现有渲染。避免测试 shadcn 内部实现或 CSS 细节。

## 8. TDD 纵向实施顺序

每一项严格执行一个行为测试 → 观察 red → 最小实现 green → 下一行为；不先批量写完所有
测试，也不在 red/green 中做无关重构。

### Slice 1 — registry、contracts 与 `local-dev`

1. 在 `@eveland/core/agent-auth` 定义 method descriptor、status/failure、request credential
   envelope 和危险 header/path 校验。
2. 创建 `packages/agent-auth` 注册表完整性校验。
3. 建立受管 route → Agent Connection adapter，以现有 `local-dev` 行为打通 `request()` 到
   Gateway，证明现有 Playground 行为不变。

### Slice 2 — config revision 与静态 methods

1. 扩展 core contracts、Drizzle schema、mappers、Store interface、memory/Postgres 实现。
2. 运行 `pnpm --filter @eveland/db db:generate` 生成新 migration，不修改已发布 migration。
3. 加密保存 config，完成 `none/basic/bearer/headers` provider。
4. Gateway 切换 canonical Host、校验并最后注入 trusted credentials。
5. 覆盖配置改变后旧 revision 不能命中新请求。

### Slice 3 — Connection API 与 Playground 设置

1. descriptors/config/status/PUT 路由。
2. redacted config 和 write-only secret 合并语义。
3. 新项目导入和 Playground Connection 设置共用 descriptor-driven 表单与校验；导入时
   创建 connection，设置页修改同一 connection，不复制 method 分支。
4. server/client API、状态展示和 `configuration_required` pending-turn 流程。

### Slice 4 — OIDC tracer bullet（Authorization Code + PKCE）

1. 引入并锁定 `openid-client` v6 与 Eve 0.24.x verifier dependency。
2. 实现保存级 discovery preflight 与 URL policy。
3. 实现 state transaction、PKCE/nonce authorize、callback、ID token 校验。
4. 用 Eve `verifyOidc` 激活 access token，记录独立 Agent subject，并写
   principal-scoped credential。
5. 进程内 OIDC mock 完成“保存 connection → 提交第一条消息 → interaction → authorize →
   callback → exactly-once resend → Playground initial session”。

### Slice 5 — expiry、refresh 与 401 recovery

1. active expiry 与无 refresh token 的 interaction fallback。
2. singleflight + Postgres lease/fencing refresh。
3. refresh token rotation、无新 refresh token、subject 保留/校验。
4. 401 一次恢复、第二次 401 同版作废/并发新版 `retry_required`、403 不恢复。
5. pending verification 的保存、复验、激活和配置性失败删除。

### Slice 6 — stream、并发与安全矩阵

1. continuation/stream reconnect 每次重新解析凭证并保留 `startIndex`。
2. callback reauthorization vs refresh、config update vs refresh、lease expiry late writer。
3. redirect/manual、invalid path/header、private issuer/JWKS、取消传播。
4. Route Auth interaction 与 Eve Connection Auth stream challenge 同时存在时互不串线。
5. 本地 OIDC mock → code flow → Eve session → 中断 → `startIndex` 重连的集成用例。

### Slice 7 — 文档与全量验证

同步：

- `docs/spec.md`：Agent Connection、Playground 首条消息 Route Auth、Caller Principal 与
  Agent Caller 身份边界、Eve Connection Auth 区别；
- `README.md`：配置入口、OIDC redirect URI、本地 mock 说明；
- `docs/deploy/linux.md`：回调 origin、APP secret、OIDC egress policy 与新增环境变量；
- `.env.example`、Compose/systemd env examples、runtime configuration diagnostics；
- 当前 handoff 中 “Test with real auth” 的历史说明。

最后再使用仓库 code-review skill 对 Standards 与 Spec 两轴复查。

## 9. 自动化验收矩阵

### 9.1 registry / static

- registration key、method、provider method、descriptor method 必须一致；重复/非法交互路径
  阻止启动。
- default `local-dev` 与当前 Playground 兼容。
- none/basic/bearer/headers 在 canonical Host 下生成预期线格式。
- 空 bearer、非法 header、secret 解密失败全部 fail closed。

### 9.2 OIDC

- Caller Principal 与 OIDC `sub` 完全不同时授权成功；二者从不比较或映射。
- 两个 Caller Principal 可分别持有同一 Agent Connection 的不同 credential；一方不能
  读取、refresh、作废或覆盖另一方。
- 同一 Caller Principal 重新授权为不同 Agent subject 时只替换自己的 credential，并
  递增 rotation。
- status 轮询不发 discovery/JWKS/token 请求。
- interaction context 缺失仍返回 `interaction_required`，但不含 URL；存在时 URL 同源且
  connection/return path 编码正确。
- callback/refresh token 只有通过 Eve verifier 后才 active。
- refresh token 新值替换、缺失时保留旧值。
- 暂时 verifier 故障保存 pending，不向 Agent 发送，不重复调用 token endpoint。
- access token 格式/签名/issuer/audience 不兼容不落 active。
- callback 无效/重放 state、Caller Principal 不匹配、过期事务、revision 改变均拒绝；
  OIDC subject 与 Caller Principal 不同不是拒绝条件。

### 9.3 并发与 401

- 两实例正常并发 refresh 时 token endpoint 只调用一次。
- lease id fencing 阻止超时旧持有者写回、释放或删除。
- callback reauthorization 递增 rotation，迟到 refresh 不覆盖。
- first 401 恢复最多一次；second 401 不发第三次请求。
- second 401 只作废被拒版本；并发新版保留并返回 `retry_required`。
- 403 不 refresh、不作废、不重试。

### 9.4 Gateway / Playground

- internal path 无 service token 返回 404；public path 不能注入 trusted envelope。
- OIDC/static 使用 canonical Host；local-dev 才使用 loopback Host。
- initial/continuation/stream 使用当前 Caller Principal 在该 connection 下的同一 credential。
- Gateway upstream 不含 Caller Principal id/email/role；Agent Caller 只由 Agent credential
  建立。
- `startIndex` query 不被编码进 pathname；浏览器取消传到 Agent upstream。
- 公开 Gateway 的 Agent-owned Authorization、Cookie、Origin、Host、streaming 行为不回归。

### 9.5 首条消息授权体验

- 新项目选择 OIDC 获取方式后，导入过程不解析 `agent/channels/eve.ts`；OIDC、Bearer 与
  custom `AuthFn` 不会因泛化的 401 challenge 被互相误判。
- 未配置 connection 时第一条消息得到 `configuration_required`，输入保持 pending；只有
  团队成员完成配置后才继续相应 method 的凭证流程。
- 没有 OIDC credential 时，提交第一条消息得到 request-level `interaction_required`；Agent
  upstream 没有收到 session POST，模型没有执行。
- callback 返回后 pending turn 只重发一次；刷新页面/重复 callback 不产生重复 Eve Session。
- 授权取消或失败保留可重试的输入，不把失败 turn 写成 Agent 回复。
- session 内的 Eve Connection Auth `authorization.required` 继续作为 stream message part，
  不与 Route Auth interaction 共用状态机。

## 10. 验证命令

实施中每个 slice 先跑单文件 Vitest 和相关 package typecheck。完成后至少运行：

```bash
pnpm --filter @eveland/core test
pnpm --filter @eveland/db test
pnpm --filter @eveland/agent-auth test
pnpm --filter @eveland/api test
pnpm --filter @eveland/gateway test
pnpm --filter @eveland/web test
pnpm --filter @eveland/web build
pnpm test
pnpm typecheck
pnpm build
git diff --check
git status --short
```

数据库 lease/transaction 语义另跑相关 Postgres integration tests。若实现或 fixture 改到
真实 Gateway/private-port/Eve runtime 行为，再运行 `bash infra/integration/run.sh`；若本机
Lima/IdP 前置条件不满足，必须明确报告未运行，不能把单元测试描述为真实拓扑验证。

## 11. 完成定义

只有同时满足以下条件才算完成：

1. Playground Caller 能为 Agent Connection 配置任意公共 issuer/client/audience，提交
   第一条消息后使用与 Eveland 账号无关的 Agent IdP 账号完成授权，并由客户端只重发一次
   pending turn，随后创建、继续和重连受保护 Eve Session；
2. access token 到期或第一次 401 能安全 refresh，永久失效会引导重新授权；
3. static method 与 default local-dev 保持可用，新增 method 不需要修改 Playground 消息
   主流程；Agent Connection 与 Eve Connection Auth 没有混用；
4. token/secret 不出浏览器、不进日志，旧 revision/callback/refresh 不能污染新配置；
5. public Gateway 继续透明传递 Agent-owned auth，internal credential handoff 不能从公网伪造；
6. memory 与 Postgres 行为、API、Gateway、Web、文档和上述验收矩阵均有对应验证结果。

## 12. 2026-07-17 增补决策:audience 可选 + UserInfo 回源验证

**动因**:金数据 account.jinshuju.net(doorkeeper-openid_connect)是"id_token 管身份、
opaque access token 管调 API"的 IdP——没有 audience 概念,access token 不是 JWT。原实现的
`verifyAccessTokenWithEve`(eve `verifyOidc`,JWT 验签 + aud 匹配)在回调处对 opaque token
必然抛 `OidcAccessTokenRejectedError`,连接永远到不了 active。这类 IdP 占半壁江山
(Google/Apple/Slack/GitLab、Auth0 不带 audience、Okta org server 等)。

**决策**:不引入新的显式模式选项,由 `audience` 的有无表达"该 IdP 是否做受众绑定":

| audience | authorize/token/refresh 请求 | access token 验证(callback 与 pending 激活、refresh 后复核共用) |
|---|---|---|
| 已配置 | 照旧发 RFC 8707 `resource`(或 `audience`,按 audienceMode) | 照旧:eve `verifyOidc`,JWT + `aud` 严格匹配,拒绝即硬失败 |
| 缺省 | 不发受众参数;`audienceMode` 单独出现即 422 | OIDC Core §5.3 UserInfo:200 且 `sub` == id_token `sub`(§5.3.2);
IdP 明确拒绝(WWW-Authenticate 401 / sub 不一致 / 无 userinfo_endpoint)→ 硬失败,
瞬态错误 → 维持 pending_verification 既有路径 |

关键点:

- 模式纯由配置决定,无运行时 token 嗅探;"audience 填了但 IdP 发 opaque token"故意硬失败
  (提前暴露错配,避免 connect 成功而 Agent 全 401 的最坏体验)。
- `OidcProtocol` 增加 `fetchUserInfo(config, accessToken, expectedSubject)`,返回
  `{outcome:"ok",subject} | {outcome:"rejected",message}`;openid-client 错误分类收在
  protocol 适配器内(`WWWAuthenticateChallengeError`、`ClientError` code
  `OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED` / `OAUTH_MISSING_SERVER_METADATA` /
  `OAUTH_INVALID_SERVER_METADATA` → rejected;其余上抛视作瞬态)。
- userinfo 模式下 `agentIssuer` 取 `config.issuer`(RP 不解析 opaque token;回源对象即信任锚)。
- descriptor 里 audience `required: false`;`normalizeOidcAuthorizationCodeConfig` 中
  audience 与 audienceMode 同进退;redact 同步条件输出。
- 失败消息不再硬编码 "Eve's verifier",改为透传 `OidcAccessTokenRejectedError.message`,
  两种模式各自给出可操作的拒绝原因。

**金数据对接参数**(UAT):issuer `https://account.uat.jinshuju.net`,scopes 显式
`openid profile`(不能留空,默认的 offline_access 会被 doorkeeper invalid_scope 拒),
audience 留空,回调 `${WEB_ORIGIN}/agent-auth/oidc/callback`。

## 13. 2026-07-17 增补决策：导入检测 + 服务端托管 Jinshuju OIDC

本节覆盖上文“导入不解析源码”和“所有 OIDC 配置都由成员填写”的绝对表述，但不改变
generic 401 不推断、任意 custom AuthFn 不静态还原的边界。

- `@eveland/core/source` 只扫描 Eve channel 模块；仅当源码实际调用
  `jinshujuOidc(...)` 时产出 `jinshuju-oidc`，只有 import 不算使用。
- Worker 在初次 `import_source` 中自动把 Project 的 Agent Connection 切换为
  `jinshuju-oidc`；后续 Sync 不覆盖成员之后的手动选择。
- `Jinshuju OIDC` 是独立 method registration，复用 Authorization Code、PKCE、token
  存储、refresh、UserInfo verification 与 `${WEB_ORIGIN}/agent-auth/oidc/callback`。
- Worker 在自动选择时、API 在成员手工保存时从
  `JINSHUJU_OIDC_ISSUER`、`JINSHUJU_OIDC_CLIENT_ID`、
  `JINSHUJU_OIDC_CLIENT_SECRET`、`JINSHUJU_OIDC_SCOPES` 解析有效配置，加密写入与其他
  method 相同的 Agent Connection 数据库记录；运行时只走统一的 DB 解密路径，浏览器不能
  提交或覆盖这些值。环境变量变化不会隐式修改已有 Connection，重新保存后才生效。
- generic OIDC 和 Jinshuju OIDC 均不在 Connection UI 暴露 token endpoint
  authentication。服务端有 client secret 时统一使用 `client_secret_basic`，没有时使用
  public-client `none`，不接受 API 或浏览器覆盖。
