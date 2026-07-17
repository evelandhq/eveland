# Agent Auth 重写与 Provider 边界实施交接

**日期：** 2026-07-17
**状态：** PR A 已在 Eve 0.24.6 的 `main` 上实施；PR B 通用 OIDC 已在 `codex/generic-oidc-authorization-code` 完成并验证、待合并；PR C 待后续独立切片
**替代对象：** PR #72 `feat: agent auth OIDC route auth` 只保留为原型和研究资料，不作为合并候选

## 1. 结论

不要继续在 PR #72 上删除 Jinshuju 特判或堆叠修复。它已经把 provider-specific 假设扩散到
core contract、source scanner、Worker、API、OIDC runtime、diagnostics、环境变量、Web、迁移、
测试和文档，继续修改会留下难以证明已经清理干净的架构残留。

从最新 `main` 创建新分支，按通用 Agent Auth、通用 OIDC、平台级变量/Secret 注入三个纵向
切片重新实现。重写的是代码边界和提交历史，不是重新发明 OIDC 协议；PR #72 中已经验证过的
安全设计、并发经验、测试场景和 UAT 结论应作为参考重新落地。

Jinshuju 的 Eve verifier 不属于 Eveland 仓库。它应由 Jinshuju 在独立仓库维护，例如：

```text
GitHub: github.com/jinshuju/oidc
npm:    @jinshuju/eve-oidc
API:    jinshujuOidc()
```

Eveland 不包含 `jinshuju-oidc` method 常量、`JINSHUJU_OIDC_*` 环境变量定义、源码扫描、自动
Connection 切换、provider-specific diagnostics 或按 provider 名分支的 OIDC 行为。

## 2. 开始实施前必须阅读

1. `docs/spec.md`
2. `README.md`
3. `docs/deploy/linux.md`
4. `docs/superpowers/plans/2026-07-13-gateway-observability-handoff.md`
5. 本文件
6. 仓库 lockfile 精确锁定的 Eve 0.24.6 Auth 文档、类型与实现：
   - `node_modules/.pnpm/eve@0.24.6_*/node_modules/eve/docs/guides/auth-and-route-protection.md`
   - `node_modules/.pnpm/eve@0.24.6_*/node_modules/eve/dist/src/public/channels/auth.d.ts`
   - `node_modules/.pnpm/eve@0.24.6_*/node_modules/eve/dist/src/public/channels/auth.js`
   - `node_modules/.pnpm/eve@0.24.6_*/node_modules/eve/dist/src/client/types.d.ts`
   - `node_modules/.pnpm/eve@0.24.6_*/node_modules/eve/dist/src/client/client.js`

Eveland 当前兼容线是 Eve 0.24.x，仓库自身、fixture 和协议验证精确锁定 Eve 0.24.6。不要根据
Eve `main`、0.24.4 或其他版本猜测协议；实现和测试应以 lockfile 中的 0.24.6 为基线。0.24.6
的 Client 原生物化 Basic、Bearer 和 Vercel OIDC；Eveland 的 Gateway envelope 仍保持通用 Header
边界，不复制这些 verifier 或按 helper 名称推断 credential acquisition。

## 3. 核心概念必须分离

### 3.1 Agent 入站 verifier

`localDev()`、`httpBasic()`、`jwtHmac()`、`jwtEcdsa()`、`oidc()`、`vercelOidc()` 和 custom
`AuthFn` 运行在 Eve Agent 内，在模型工作开始前验证传入请求并建立 Agent Caller。

这是 Eve/Agent 侧能力。Eveland 不复制或重新实现这些 verifier。

### 3.2 Eveland 调用端 credential provider

Eveland Playground 是 Agent 客户端。它负责为每次 initial session、continuation 和 stream
请求取得并发送 Agent 能接受的凭证。

一个 verifier 不唯一决定 credential acquisition：

- `oidc()` 可能对应静态 Bearer、Authorization Code、client credentials 或 token exchange；
- `jwtHmac()` / `jwtEcdsa()` 只定义 Agent 如何验签，不表示 Eveland 应自动成为 JWT issuer；
- custom `AuthFn` 可能使用 Cookie、Header、签名或完全自定义协议；
- `WWW-Authenticate: Bearer` 不能区分上述方式。

因此 Eveland 只能提供显式选择的客户端 provider，不从 verifier 名、401 challenge 或源码函数名
推断 credential acquisition method。

### 3.3 Caller Principal 与 Agent Caller

Eveland member id 只用于隔离 delegated credential，称为 Caller Principal。它不得被发送到
Agent，也不得与 OIDC `iss/sub`、email 或 Agent Caller 比较、映射或隐式合并。

Agent Caller 完全由 Agent 收到的 credential 及其 Eve verifier 建立。

### 3.4 Route Auth 与 Eve Connection Auth

本计划处理调用 `/eve/v1/session*` 前的 Route Auth。Agent 会话内部工具产生的
`authorization.required` 属于 Eve Connection Auth，继续走现有 stream/HITL UI，不进入本计划
的 Agent Connection 或 OIDC callback 状态机。

## 4. Eve verifier 与 Eveland 客户端能力矩阵

| Eve Agent 入站 helper | Eveland 调用端能力 | 说明 |
| --- | --- | --- |
| `localDev()` | loopback authority，无 credential | 仅 privileged internal Playground path 可用 |
| `none()` | canonical authority，无 credential | 不代表 Gateway 放松公共认证边界 |
| `httpBasic()` | Basic credential provider | username/password 加密保存，按请求物化 Header |
| `jwtHmac()` | Bearer 或显式 managed JWT signer | 默认发送外部签发 token；不要隐式让 Eveland 成为 issuer |
| `jwtEcdsa()` | Bearer 或显式 managed JWT signer | 同上；私钥签发能力若需要，应独立设计和授权 |
| `oidc()` | 通用 OIDC provider family | Authorization Code 只是其中一种 acquisition strategy |
| `vercelOidc()` | 独立 Vercel provider | 参考 Eve 的客户端镜像；不要硬编码进 generic OIDC |
| custom `AuthFn` | custom headers 或未来外部 provider | 不做自动推断，不允许危险 Header |

“完整支持 Eve helper”指完整覆盖调用端兼容矩阵和协议测试，不是复制 Eve verifier 实现。

## 5. Eveland 目标架构

### 5.1 包边界

建议保留以下通用结构：

```text
packages/core
  browser-safe Agent Auth contracts
  method descriptors
  failure/status shapes
  trusted Gateway credential envelope
  reserved-header policy

packages/agent-auth
  Node-only Agent Auth module
  provider registry
  configuration normalization/redaction
  sealed configuration/transaction/credential helpers
  credential lifecycle and request retry pipeline
  generic OIDC Authorization Code implementation

packages/db
  Agent Connection
  scoped credentials
  one-time interaction transactions
  revision/rotation/lease fencing
  memory and Postgres behavior
```

通用 OIDC 可以先作为 `@eveland/agent-auth/oidc` subpath。只有当依赖或发布边界确实需要时，才拆成
独立 generic package；不要为了形式对称提前增加包。

Provider registration 的 `method` 是扩展拥有的不透明字符串。core、DB、Gateway 和 Web 不得按
provider 名称分支。

### 5.2 通用 registry

registry 至少描述：

```ts
type AgentAuthProviderRegistration = {
  method: string;
  descriptor: AgentAuthMethodDescriptor;
  credentialScope: "connection" | "principal";
  authority: "loopback" | "canonical";
  normalizeConfig(input: unknown, existing?: unknown): unknown;
  redactConfig(config: unknown): Record<string, unknown>;
  getCredential(context: AgentCredentialContext): Promise<CredentialResolution>;
  inspect?(context: AgentCredentialContext): Promise<AgentAuthStatus>;
  recoverUnauthorized?(context: UnauthorizedRecoveryContext): Promise<RecoveryResult>;
  interaction?: AgentAuthInteractionHandler;
};
```

API、Web 消息主流程和 Gateway 不允许出现按 method 的 `switch`。provider-specific 行为通过注册表
和 composition root 注入。

### 5.3 Agent Connection

一个受管 Project 当前最多一个稳定 Agent Connection。Connection 是客户端配置，不是 Project、
Deployment 或 Eve Connection。

Connection 保存：

- opaque provider method；
- encrypted normalized config；
- security revision；
- managed Project target；
- created/updated timestamps。

只有 method、target 安全语义或归一化配置发生语义变化时递增 revision。原样保存不得无条件使所有
principal credentials 失效。

### 5.4 凭证 scope

- `connection`：Basic、静态 Bearer、custom headers 等机器/共享 credential；
- `principal`：交互式用户授权，按 `(agentConnectionId, callerPrincipalId)` 隔离。

credential AAD 必须绑定 connection、security revision、method、scope、scope subject 和 key。
旧 revision 不再命中新请求；过期 revision 记录可以异步清理。

### 5.5 Gateway 边界

API 解密并解析一次请求需要的 credential，通过现有 service-authenticated internal Playground path
发送严格校验、带版本号的 envelope。

Gateway：

- 仅在 internal service token 验证后接受 envelope；
- `local-dev` 使用 loopback Host；
- 其他 provider 使用 canonical Agent Host；
- credential Header 最后写入；
- 不持久化、不 refresh、不解密 provider token；
- 公共路径继续删除外部 `X-Eveland-*`；
- public Agent `Authorization`、Cookie、Origin、Host 和 streaming 行为保持透明。

## 6. 通用 OIDC Authorization Code Provider

第一阶段 OIDC provider 使用 `openid-client`，不要手写 OAuth/OIDC 协议。

通用配置只使用协议概念：

```ts
type OidcAuthorizationCodeConfig = {
  issuer: string;
  clientId: string;
  clientSecretRef?: SecretReference;
  scopes: string[];
  audience?: string;
  audienceMode?: "resource" | "audience" | "both";
  tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post" | "none";
  authorizationParams?: Record<string, string>;
  accessTokenVerification: "eve-jwt" | "userinfo";
};
```

不要通过 provider 名推导 `client_secret_post`、prompt、scope 或 verification mode。可以提供安全的
通用默认值，但归一化后的语义必须显式且可测试。

必须实现：

- discovery；
- Authorization Code + PKCE S256；
- state 和 nonce；
- Web-owned callback page；
- authenticated API callback；
- 一次性、短期 transaction；
- encrypted principal-scoped token；
- access/refresh token 到期处理；
- refresh token rotation；
- 进程内 singleflight；
- Postgres lease/rotation fencing；
- callback/refresh 后的 access-token 激活验证；
- 第一次 401 最多恢复和重发一次；
- 第二次 401 不产生第三个 Agent 请求；
- 403 不 refresh；
- AbortSignal、NDJSON streaming 和 stream reconnect 语义不回归。

JWT 模式可复用 Eve `verifyOidc`，但必须绑定已配置的 issuer/audience。UserInfo 模式必须检查
UserInfo `sub` 与已经验证的 ID Token `sub`，并区分永久拒绝与暂时 provider failure。

## 7. 平台级变量与 Secret 注入

Jinshuju package 所需环境变量应由未来的通用平台能力提供，而不是加入 Eveland 的硬编码环境变量
清单。

目标能力：

- operator-owned platform variables；
- encrypted platform Secret Profile；
- Project/Deployment 显式绑定；
- Agent Connection 使用 secret reference，而不是复制明文；
- allowlisted diagnostics 只显示来源、绑定和 configured 状态；
- runtime-only injection；
- 更新后明确的 revision/restart 行为；
- API、Worker 和 Agent runtime 的 consumer scope 明确分开。

Secrets 不得进入：

- source snapshot；
- immutable Release；
- Docker build layer；
- generated Dockerfile；
- observer event；
-日志和错误响应；
- Web payload。

不要假设“注入到 Agent 的环境变量”会自动配置 Eveland API 的 OIDC client。Agent verifier 配置和
Playground credential provider 配置是两个 consumer；共享值应通过通用 Secret reference/profile
显式绑定，并遵循最小权限。Agent verifier 不需要的 OAuth client secret 不得注入 Agent runtime。

## 8. Jinshuju 独立仓库责任

`github.com/jinshuju/oidc` 负责：

- 发布 `@jinshuju/eve-oidc`；
- 暴露 Eve-compatible `jinshujuOidc()`；
- 读取或接受 Jinshuju 自己定义的 runtime 配置；
- 缺少配置时 fail closed；
- 不记录 token、client secret 或可恢复的 Secret 信息；
- 将验证成功结果映射为 Eve `SessionAuthContext`；
- 覆盖 opaque access token、UserInfo subject、无效/过期 token 和 provider failure；
- 使用 Eveland generic OIDC caller 做互操作 UAT。

建议 package 默认在调用 `jinshujuOidc()` 时解析 runtime env，而不是在模块 import/build 阶段读取
Secret。为了测试和非 Eveland 部署，可以允许显式 options 覆盖默认环境来源。

Eveland 不负责该 package 的版本、环境变量 schema、provider 文档或发布流程。

## 9. 不进行源码自动推断

删除并禁止以下做法：

- 在 `@eveland/core/source` 搜索 `jinshujuOidc(...)`；
- 根据 import 名、函数名或字符串自动选择 Agent Connection；
- 根据通用 401 / `WWW-Authenticate` 自动猜 OIDC；
- 在 Sync 时修改用户选择的 Connection；
- 从任意 custom `AuthFn` 尝试还原客户端 credential provider。

未来若 Eve 提供标准化、可序列化的 Route Auth metadata，Eveland 可以把它作为非敏感 hint 或预填
信息，并要求用户确认。metadata 不能携带 client secret，也不能绕过显式配置与权限边界。

## 10. PR #72 处置

建议执行：

1. 将 PR #72 转为 Draft；
2. 在描述顶部注明架构边界调整，不再作为合并候选；
3. 保留 branch 和讨论作为 prototype/reference；
4. 不再向该 branch 添加实现提交；
5. 新 PR 合并后关闭 #72，并链接替代 PR。

不要整体 cherry-pick #72 的提交。其早期 generic commits 也已经被后续 provider-specific 假设影响。
按行为、测试场景和小段实现人工移植。

### 10.1 可复用的设计和实现经验

- Agent Connection 与 Caller Principal/Agent Caller 分离；
- versioned credential envelope；
- canonical/loopback authority；
- AES-256-GCM、用途派生和 AAD；
- security revision、rotation、lease fencing；
- 401/403 恢复规则；
- Web callback 和 pending turn；
- `openid-client` 的 PKCE/state/nonce 使用；
- JWT audience 与 UserInfo 两种验证经验；
- Jinshuju/Vercel interoperability 的 UAT 结论。

### 10.2 必须舍弃或重新生成

- `jinshuju-oidc` method 和所有 provider-name branches；
- `JINSHUJU_OIDC_*`；
- source scanner 和 Worker auto-selection；
- provider-specific config diagnostics；
- PR #72 的 migration `0018_slow_talisman.sql`；
-旧 migration snapshot；
- 已被后续决策覆盖的实施计划和文档段落。

新实现应从最新 schema 重新运行 `pnpm --filter @eveland/db db:generate`，不得复制未合并 branch 的
migration 编号或 snapshot。

## 10.3 当前 main 实施进度（Eve 0.24.6）

本轮已完成 PR A：browser-safe core envelope/header policy、Node-only registry、`local-dev` /
`none` / Basic / Bearer / custom headers、加密 Connection config、revision/credential fencing、
memory/Postgres store 与新 migration、API/Web Connection 设置，以及 Gateway trusted envelope。
rolling upgrade 期间，service-authenticated internal Playground 请求缺少 envelope 时暂时保持旧的
loopback 行为；当前 API 始终发送显式 envelope。这个兼容 fallback 应在部署完成并有独立迁移窗口后删除。

PR B 通用 OIDC 和 PR C 平台级变量/Secret Profile 仍保持独立纵向切片，不得为了“完成同一个 PR”
把 provider-specific 代码或 runtime Secret 注入混入 PR A。

## 11. 分阶段 PR

### PR A：通用 Agent Auth 基础

范围：

- core contracts/envelope/header policy；
- registry；
- Agent Connection 和 encrypted config；
- connection/principal credential scope；
- `local-dev`、`none`、Basic、Bearer、custom headers；
- Gateway trusted envelope；
- Playground Connection 设置；
- configuration redaction；
- migration、memory/Postgres store；
- spec、README、deploy docs。

不包含 OIDC、provider-specific code、source detection 或 platform Secret Profile。

### PR B：通用 OIDC Authorization Code

实施状态：`codex/generic-oidc-authorization-code` 已完成 generic registration、Web-owned callback、
pending first turn、加密 transaction/principal credential、JWT/UserInfo verification、refresh rotation、
process singleflight、Postgres lease/rotation fencing、单次 401 recovery、cleanup 和双语文档；使用 Eve
0.24.6 与 `openid-client` 6.8.4。真实 Postgres two-store concurrency 与进程内 mock IdP protocol
matrix 已通过，待 PR 合并后把本段状态更新为 `main`。

范围：

- generic OIDC registration；
- Web callback；
- pending first turn；
- encrypted transaction/credential；
- JWT/UserInfo verification；
- refresh、singleflight、Postgres fencing；
- 401 recovery；
- transaction/old-revision cleanup；
-真实 Postgres concurrency tests；
- generic OIDC docs。

### PR C：平台级变量与 Secret Profile

范围：

- platform-owned variables/secrets；
- binding and references；
- runtime injection；
- diagnostics/permissions；
- restart/revision behavior；
- Compose/systemd/preflight/docs；
- Secret 不进入 Release/build/observer/log 的验证。

Jinshuju package 和发布在独立仓库单独推进，不是 PR C 的一部分。

## 12. TDD 与验证要求

所有 feature/bugfix 按仓库规则先写最窄失败测试，再实现。

### 12.1 PR A 必测

- registry key/descriptor/provider 一致性；
- duplicate/invalid method 拒绝启动；
- `local-dev` 仅使用 loopback authority；
- 其他方法使用 canonical Host；
- Basic/Bearer/headers 正确物化；
-危险 Header 拒绝；
- browser/API payload 不泄漏 Secret；
- unchanged normalized config 不递增 revision；
- changed config 使旧 credential 失效；
- public Gateway 不能伪造 envelope；
-现有 public Authorization/Cookie/Origin/streaming 不回归；
- Project 删除级联清理 Connection/credentials。

### 12.2 PR B 必测

- PKCE/state/nonce；
- transaction 过期、重放、caller mismatch、revision mismatch；
- abandoned/expired transaction cleanup；
-两个 Caller Principal 完全隔离；
- Caller Principal 与 IdP subject 不同仍成功；
- callback/refresh token 只有验证后才 active；
- refresh token rotation；
- pending verification；
- permanent rejection 与 temporary provider failure；
-跨实例只有一个 refresh caller；
-等待者不会在正常 token endpoint latency 内过早返回 503；
- lease expiry late writer 不能完成、释放或删除新版 credential；
- callback vs refresh；
- config update vs callback/refresh；
- first 401 只重发一次；
- second 401 无第三次 upstream call；
- 403 无 refresh；
- callback 后 pending turn exactly once；
- initial/continuation/stream reconnect 每次重新解析当前 credential。

### 12.3 真实环境验证

Agent Auth DB 语义不能只用 memory store 证明。CI 或合并前验证必须提供真实 Postgres：

- apply generated migration；
- two-store/two-instance lease competition；
- transaction atomic consume；
- CAS completion/release/delete；
- callback/refresh/config races；
- Project deletion cascade。

Generic OIDC 使用进程内 mock IdP 覆盖协议矩阵，并至少对一个真实 IdP 做 UAT。Jinshuju UAT 属于
外部 package interoperability，不应把 provider 代码带回 Eveland。

每个 PR 至少运行：

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @eveland/web build   # Web/Next/browser boundary 变更时
git diff --check
git status --short
```

数据库变更另行运行配置了 `EVELAND_POSTGRES_TEST_URL` 的相关 integration tests。Gateway/private-port
或 Linux runtime 行为发生变化时，再运行 `bash infra/integration/run.sh`；未运行必须明确报告。

## 13. 安全与运行不变量

- Gateway 不是 Agent IdP；
- control-plane login 不是 Agent credential；
- public Agent auth 完全由 Agent 拥有；
- internal Playground path 继续 service-authenticated 且公网不可达；
- public request 永不被重写为 localhost Host；
- token/client secret/password 不进浏览器、日志、事件、fixture snapshot 或错误响应；
- OIDC issuer/endpoint 必须有应用层 URL policy，并要求生产 egress policy；
- redirect 使用 manual/error，credential 不跟随跨 origin redirect；
- transaction 有 TTL 和实际清理机制，不能只保存 `expiresAt`；
- refresh wait/timeout/lease TTL 必须一致；
- API/Worker/Agent runtime 的 Secret consumer scope 遵循最小权限；
- observer failure、Agent Auth provider failure不得扩大为 public Gateway 身份绕过。

## 14. 完成定义

只有满足以下条件，Agent Auth 才可视为完成：

1. Eveland core、DB、API、Worker、Gateway、Web、diagnostics 和 docs 中没有 Jinshuju 知识；
2. 通用 Agent Auth 覆盖 Eve verifier helper 的调用端兼容矩阵；
3. verifier 与 credential acquisition 不被自动等同；
4. OIDC provider 完全使用协议级配置，不按 provider 名分支；
5. Caller Principal 与 Agent Caller 始终分离；
6. public Gateway 透明性与 internal privileged path 边界不回归；
7. token/Secret 只在允许的 runtime 边界出现；
8. memory 与真实 Postgres 的 revision/transaction/refresh fencing 均验证；
9. abandoned transaction 和旧 revision 数据有清理路径；
10. Jinshuju 通过外部 package 与 Eveland generic OIDC 完成互操作，不要求 Eveland 发布 provider code。

## 15. 新 session 的第一步

1. 确认 `git status --short`，保留用户已有改动；
2. 更新本地 `main` context，并重新读取本文件和产品 spec；
3. 不 checkout 或继续修改 PR #72 branch；
4. 为 PR A 写一份只覆盖 generic Agent Auth 的小型实施清单；
5. 从最窄 contract test 开始，先证明 `local-dev` 与 canonical `none` 的 authority 边界；
6. 每完成一个纵向行为再进入下一项，不提前加入 OIDC 或 provider-specific extension。
