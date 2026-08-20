# Agent Catalog 与 Eveland Identity 边界交接

**日期：** 2026-07-28  
**状态：** 2026-07-28 已完成实施与跨仓验收；改动保留在两个未提交的
`codex/agent-catalog-v0` worktree，等待人工测试。  
**实施顺序：** 先完成 Agent Catalog v0 和 Agent 入站认证 continuation，再继续
Connections provider-neutral 设计。

## 1. 新 session 从哪里开始

不要从干净 `main` 重新实现。复用以下两个现有 worktree：

```text
Eveland:
/Users/michael/.codex/worktrees/cd9f/eveland

EveChats:
/Users/michael/.codex/worktrees/a198/eve-chats
```

原因：

- Eveland 已有可复用的 `eveChannel` capability scan、Source Revision 持久化、Stable route
  查询骨架、公共 Gateway URL helper、App Token 和 JWT signing 重构。
- EveChats 已有可复用的 Catalog 首页、lazy upsert、稳定 managed identity、历史聊天保留、
  旧 `/.well-known/eve/agents.json` 发现路径删除、catch-all Eve proxy route 和 App Token
  隔离工作。
- 从干净 `main` 开始会重复约千行已经完成的 UI、数据库和代理工作，同时更容易漏掉旧协议删除。

两个 worktree 都是 dirty worktree，且未提交。开始实施前分别创建工作分支，保留当前改动：

```bash
cd /Users/michael/.codex/worktrees/cd9f/eveland
git switch -c codex/agent-catalog-v0

cd /Users/michael/.codex/worktrees/a198/eve-chats
git switch -c codex/agent-catalog-v0
```

不要执行 `git reset --hard`、`git checkout -- .` 或删除未跟踪文件。先按本文件的
“保留 / 修改 / 删除”清单拆解现有 diff。

当前基线：

```text
Eveland HEAD: eded6da (origin/main)
Eveland state: detached HEAD, 16 个已修改文件，约 +631/-34

EveChats HEAD: a047d2f (origin/main)
EveChats state: main 上 dirty，40 个变更文件，约 +1143/-789
```

当前 dirty 实现不是已经验证的最终产品；本轮讨论没有运行测试、typecheck 或 build。

## 2. 最终确认的产品边界

### 2.1 Agent Catalog 只是只读投影

Agent Catalog 回答：

> 这个 Eveland 实例有哪些可供 Eve 客户端聊天的 Agent？

收录条件只有：

1. 对应已部署 Source Revision 显式提供标准 `eveChannel(...)`；
2. Project 有可路由的 Stable Deployment。

Catalog：

- 不创建独立 Catalog 记录；
- 不按 `evelandIdentity()`、`httpBasic()`、`localDev()` 或其他 AuthFn 筛选；
- 不动态请求或探测 Agent；
- 不做 marketplace、分类、搜索、发布审核；
- 不包含或推断 Agent auth 配置；
- 不创建持久化聊天连接；
- 不承担业务授权。

Catalog entry 使用 Project ID 作为 Eveland 实例内的稳定 Agent ID。客户端应使用
`Eveland instance/issuer + projectId` 识别 managed Agent，而不是以 URL 为主键。

目标 endpoint：

```http
GET /agent-catalog
```

不使用：

```text
/identity/agents   # Catalog 不属于 Identity 领域
/agents            # 容易被理解为与 /projects 并列的 CRUD 资源
/public-agents     # 不应把访问策略编码进资源名
/catalog/agents    # v0 只有 Agent Catalog，层级多余
```

目标响应：

```json
{
  "agents": [
    {
      "projectId": "proj_...",
      "name": "Finance Analyst",
      "description": "Analyzes financial reports.",
      "url": "https://finance-agent.example.com",
      "capabilities": {
        "eveChat": true
      }
    }
  ]
}
```

是否要求一个有效 Eveland Identity Session 才能读取 `/agent-catalog` 尚未最终锁定。
如果 v0 沿用登录后读取，也必须保证所有登录用户得到相同列表；Identity Session 只保护
Catalog endpoint，不参与 Project 过滤。不要因此把 endpoint 放回 `/identity/*`。

### 2.2 删除 Realm → Project access

`/settings/identity` 不再配置 Project access。删除以下产品能力：

- Realm → Project grant UI；
- grant 管理 API；
- Caller Token issuance 中的 Project grant 检查；
- Catalog query 中的 grant join；
- “撤销 grant 后 Agent 从 Catalog 消失”的行为和测试；
- 相关 README/spec 表述。

Catalog 对所有可访问它的用户返回相同 Agent 列表。Agent 自己负责业务授权。

由于 Realm → Project grant 已经存在于 `main` 的 schema/migration 中，删除数据库表时必须新增
Drizzle migration；不能重写已经发布的旧 migration。纯删除不需要写只断言旧 route/table
不存在的 tombstone test。

Realm 本身是否仍作为 Identity namespace 保留，不在本交接中决定。只确认 Realm 不再分配 Project。

### 2.3 Eveland 只做身份认证，不做 Agent 业务授权

Eveland 的职责：

- 运行当前启用的 Agent-user Identity Provider；
- 把外部身份归一化成 Eveland principal；
- 建立独立 Identity Session；
- 签发短时、Project-audience、ES256 Caller Token；
- 发布 JWKS；
- 向 Caller Token 投影允许 Agent 使用的标准身份属性。

Agent 的职责：

- 验证 route credential；
- 根据 Eveland principal、claims 和自己的业务数据授权；
- 对不允许的用户返回 `403`。

示例：

- 财务分析 Agent 只允许财务人员；
- 产品分析 Agent 只允许产品经理。

这些都是 Agent 业务逻辑。Eveland 不配置“某部门 → 某 Project”，也不持有该分配规则。

Eveland 可以配置“只信任金数据某个 tenant”或“只信任企业微信某个企业”，因为这是实例的
身份信任边界；它不配置这个 tenant 内的哪个角色可以访问哪个 Agent。

### 2.4 一个 Eveland 实例暂时只有一个 active Identity Provider

v0/v1 先采用：

```ts
type ActiveIdentityProvider =
  { kind: "internal" } | { kind: "oidc" /* provider-neutral OIDC config */ };
```

当前为 Internal Provider；下一步预计加入金数据 OIDC。Agent 与客户端都不应知道 Eveland
背后使用 Internal、金数据或未来其他 provider。

以后如果需要同一实例同时支持金数据 tenant 和企业微信企业登录，再设计：

- provider 选择或路由；
- account linking；
- 跨 provider 稳定 principal；
- 相同邮箱冲突；
- provider 切换后的身份连续性。

现在不实现 provider 数组和选择 UI，但内部接口不要把 `internal` 写死进 Caller Token 验证路径。

### 2.5 `evelandIdentity()` 表示把认证委托给 Eveland

`evelandIdentity()` 的语义是：

> Agent 信任当前 Eveland 实例签发的标准 Caller Token；具体如何登录由 Eveland 决定。

Agent 只关心统一 Caller Token，不关心上游 provider。客户端也不负责选择 Internal、金数据或
企业微信。

Agent auth 方法与 Catalog membership 完全独立：

| Agent route auth           | Catalog | Eveland 是否参与                                    |
| -------------------------- | ------- | --------------------------------------------------- |
| `none()`                   | 收录    | 不参与                                              |
| `localDev()`               | 收录    | 不参与；仅 loopback/local development               |
| `httpBasic()`              | 收录    | 不参与；客户端处理 Basic credential                 |
| `jwtHmac()` / `jwtEcdsa()` | 收录    | 默认不参与；客户端必须有对应 Bearer token           |
| general `oidc()`           | 收录    | 默认不参与；客户端走 Agent 指定的通用 OIDC          |
| `vercelOidc()`             | 收录    | 不参与；支持该 workload identity 的客户端取得 token |
| `evelandIdentity()`        | 收录    | 参与；Eveland 负责完整身份流程并签发 Caller Token   |
| custom `AuthFn`            | 收录    | 不推断；客户端按 Agent 协议处理                     |

`localDev()` 不是匿名认证；真正匿名的是 `none()`。

### 2.6 客户端不根据 Catalog Project ID 自动发送 Caller Token

以下规则已经被明确否决：

```text
Catalog entry 有 projectId
→ 客户端自动取得 Caller Token
→ 所有 Agent 请求都发送该 Bearer
```

`projectId` 只提供稳定 managed identity 和 Caller Token audience 所需的资源标识，不表示
Agent 使用了 `evelandIdentity()`。

EveChats 与未来 CLI 都必须先遵循 Agent route auth。只有 Agent 表示需要 Eveland Identity 时，
客户端才进入 Eveland continuation 并取得 Caller Token。

EveChats 只是一个客户端，不应该承担 provider registry 或猜测 Agent 源码配置。其他客户端也应能
实现同一协议。

## 3. Agent route authentication continuation

### 3.1 与 Eve Connection authorization 不同

Eve 0.27.6 已有 stream event：

```text
authorization.required
authorization.completed
```

它用于已经建立 Agent session、已经开始 turn 后，GitHub、Linear 等 Eve Connection 需要用户授权。
当前 challenge shape 是：

```ts
type ConnectionAuthorizationChallenge = {
  url?: string;
  userCode?: string;
  expiresAt?: string;
  instructions?: string;
  displayName?: string;
};
```

Agent route auth 发生得更早：

```text
HTTP request
→ eveChannel routeAuth
→ authenticated principal
→ Eve session
→ turn
→ stream events
```

没有通过 `evelandIdentity()` 时，还没有 session、turn 或 event stream，因此不能直接发
`authorization.required` stream event。

可以复用相同的 interaction/challenge 数据结构，但应通过 HTTP `401` 返回，并在语义上称为
`authentication_required`，避免把“证明调用者是谁”和“授权 Agent 使用外部服务”混为一谈。

### 3.2 目标交互

建议继续设计类似：

```http
HTTP/1.1 401 Unauthorized
Cache-Control: no-store
Content-Type: application/json
```

```json
{
  "code": "authentication_required",
  "authentication": {
    "kind": "eveland",
    "url": "https://eveland.example/identity/continue/...",
    "expiresAt": "2026-07-28T12:00:00Z",
    "displayName": "Eveland"
  }
}
```

最终字段名、是否同时使用 `WWW-Authenticate`、是否采用 OAuth Protected Resource Metadata，
本轮尚未最终决定。实现前应先写一个小型协议 contract 和浏览器/CLI 消费测试，再选择具体格式。

必须满足：

- URL 由 Eveland 控制，而不是客户端拼接 provider authorization URL；
- continuation 短时、签名、单次使用；
- return target 使用 allowlist，不接受任意开放重定向；
- Eveland 检查自己的 Identity Session；
- 有 Session 时无感继续；
- 无 Session 时由 Eveland 选择当前唯一 active provider；
- provider 完成后 Eveland 签发统一 Caller Token；
- 浏览器客户端进行 top-level navigation；
- CLI 可以打开浏览器、打印 URL，未来也可显示 device `userCode`；
- 客户端取得 credential 后重试原 Agent 请求；
- Gateway 原样转发 Agent 的 401/challenge，不解释身份；
- 不允许 credential-bearing `fetch` 盲目跟随跨域 302。

客户端在技术上执行导航，但不决定认证方式。Internal、金数据 OIDC 或未来 provider 的选择和
跳转完全由 Eveland continuation endpoint 完成。

### 3.3 多 AuthFn 必须继续工作

Eve route auth 是有序 fallback：

```ts
eveChannel({
  auth: [
    evelandIdentity(),
    httpBasic(...),
    localDev(),
  ],
});
```

缺少或不匹配 Eveland token 时，`evelandIdentity()` 必须允许后续 AuthFn 尝试。不要简单地在
缺少 token 时直接 throw/redirect，否则会阻断 Basic 和 localDev fallback。

Eve 0.27.6 的 `routeAuth()` 已能聚合 AuthFn 声明的 `WWW-Authenticate` challenges：

- `httpBasic()` 声明 Basic；
- JWT、OIDC、Vercel OIDC 声明 Bearer；
- `evelandIdentity()` 当前没有声明 Eveland-specific metadata，最终只表现为普通 Bearer。

需要先决定如何让 `evelandIdentity()` 在不破坏 fallback 的前提下声明 Eveland continuation。
可能需要扩展 `withAuthChallenges()`/`routeAuth()` 的 challenge contract，或者使用带参数的 Bearer
challenge；不要在没有多-auth contract test 的情况下实现。

## 4. Eveland 当前 dirty diff：保留、修改、删除

### 4.1 保留并补充测试

- `packages/core/src/source.ts`
  - `EveProjectCapabilities`
  - `capabilities.eveChat`
  - 标准 `agent/channels/eve.*` 的显式 `eveChannel(...)` 检测
- `packages/core/src/source.test.ts`
- `apps/worker/src/source/scan.ts`
- `apps/worker/src/jobs/process.test.ts`
- `apps/api/src/app-support.ts` 的 `publicGatewayUrl()`
- `packages/identity-broker` 的通用 JWT signing helper 重构
- `/identity/app-tokens` 与 App Token audience
  - 它保护 EveChats 自己的历史与外部 Agent 数据；
  - 它不能替代 Agent Caller Token；
  - 它与 Project grant 删除相互独立。

Source scan 仍然只做 capability 检测，不扫描 auth helper。

### 4.2 修改

- 将 `GET /identity/agents` 移为 `GET /agent-catalog`。
- Catalog contract 不应继续放在 `@evelandhq/core/identity`；移到合适的 browser-safe catalog/contracts
  模块。
- 将 `listIdentityRealmAgentCatalog(realmId)` 改成与 Identity/Realm 无关的 Catalog query。
- SQL 不再 join `identityRealmProjectGrants`。
- Catalog 继续读取 Stable route 的正权重 target 对应的
  Deployment → Release → Source Revision，而不是 current Source Revision。
- Stable route 支持 scale-to-zero 时，`stopped` Deployment 仍可收录；没有 Stable route 或
  不可路由的 Deployment 不收录。
- 多 target Stable route 的所有正权重 target 都必须对应声明 `eveChat=true` 的已部署 revision，
  避免一次请求随机落到不支持聊天的 Deployment。
- Caller Token issuance 删除 grant 检查。
- `agent_url` claim 是否继续用于客户端代理的 endpoint-substitution 防护可以保留研究，但它不能再
  依赖 Catalog grant，也不能让客户端据此自动认为 Agent 使用 Eveland Identity。
- 更新 `README.md`、`docs/spec.md` 和相关 operational 文档。

### 4.3 删除

- `identityRealmProjectGrants` schema 和 Store contract/implementation；
- grant API：
  - `GET /system/identity/realms/:realmId/grants`
  - `PUT /system/identity/realms/:realmId/projects/:projectId`
  - `DELETE /system/identity/realms/:realmId/projects/:projectId`
- `/settings/identity` 的 Project access UI；
- `packages/identity-broker` 的 `hasIdentityRealmProjectGrant()` issuance gate；
- grant persistence/API/UI tests；
- grant-based Catalog tests和文档；
- “撤权后 Agent 不可访问/从 Catalog 消失”的旧验收。

删除表必须生成新 migration，不修改旧 migration。

### 4.4 新增

- 独立 Catalog route module，保持 `apps/api/src/app.ts` 为 composition root；
- Catalog Store domain query；
- `/agent-catalog` contract tests；
- `evelandIdentity()` authentication continuation contract；
- Internal Provider continuation integration test；
- 至少一个多-auth fallback test，例如 `[evelandIdentity(), httpBasic()]` 或
  `[evelandIdentity(), localDev()]`；
- Gateway 透明转发 401/challenge 的回归测试，如现有覆盖不足。

## 5. EveChats 当前 dirty diff：保留、修改、删除

### 5.1 保留

- `/agents` 自动读取和显示 Catalog；
- 点击后 lazy upsert `AgentConnection`；
- managed Agent 稳定 identity：Eveland instance/issuer + Project ID；
- URL 更新不创建重复 Agent；
- 历史聊天在 Agent 离开 Catalog或下线后继续可读；
- unavailable 状态阻止新 turn，但不删除历史；
- 手动外部 Agent 保留；
- 删除旧 `/.well-known/eve/agents.json` discovery UI/route；
- consolidated catch-all Eve proxy route；
- App Token 保护 EveChats 自己的数据；
- database migration 中 managed identity unique index；
- Catalog UI 与 repository tests 中与上述行为一致的部分。

### 5.2 修改

- Catalog URL 改成 `<EVELAND_ORIGIN>/agent-catalog`。
- `evelandProjectId`/managed connection 不再隐含 Eveland route auth。
- 点击 Catalog Agent 时只 lazy upsert/open，不预取 Caller Token。
- Agent request 首先按普通 Eve client request 发出。
- 收到 Eveland `authentication_required` 后才进入 Eveland continuation、取得 Caller Token并重试。
- App Token 继续保护 EveChats API/history；Caller Token 只作为 Agent credential 使用。
- Basic、anonymous、localDev 或其他 Agent-owned auth 不得被 managed connection 分支禁止。
- Catalog availability 只根据当前 Catalog presence/stable availability，不再出现 grant-revoked 语义。
- 保留 chat 历史 scope，但重新检查 `identityIssuer/evelandProjectId` 是否只用于稳定资源 identity，
  不应被当作 caller-auth proof。
- 更新所有测试中“managed means Caller Token”的假设。

### 5.3 删除或重写

- `src/eve/auth.ts` 中：

  ```text
  connection.evelandProjectId
  → 必须提供 Caller Token
  → 禁止 legacy/manual auth
  ```

- `src/eve/client.ts` 中基于 `evelandProjectId` 自动选择 Bearer auth；
- `src/components/agent-catalog.tsx` 点击时的 `getCallerToken()`；
- `authenticated-chat-thread`、`new-chat-composer`、chat bootstrap 中仅因 Project ID 自动预取 token；
- server proxy 中仅因 managed identity 自动验证并转发 Caller Token；
- “Project access revoked”命名的测试，改为 Agent 不在 Catalog/Stable route unavailable；
- README 和 local-development 文档中的 grant 与 automatic Caller Token 描述。

不要删除 Caller Token verifier/cache 本身；它仍用于 Eveland challenge 完成后的 Agent credential。

## 6. 新的验收闭环

### 6.1 Catalog

1. 部署一个显式使用标准 `eveChannel()` 的 Agent。
2. Agent 出现在 `GET /agent-catalog`。
3. Catalog entry 包含 `projectId`、metadata、Stable URL 和 `eveChat=true`。
4. 使用 `none()`、`localDev()`、`httpBasic()` 或 `evelandIdentity()` 都不影响 Catalog membership。
5. 没有显式标准 Eve Channel 的 Project 不出现。
6. 没有 Stable Deployment 的 Project 不出现。
7. current Source Revision 已改变但尚未部署时，Catalog仍反映 Stable Deployment 的不可变 revision。
8. Stable URL变化不会在 EveChats 创建第二个 managed identity。
9. Agent 下线或离开 Catalog 后历史聊天仍可读，新 turn 显示 unavailable。

### 6.2 Agent auth

1. `none()` Agent 不请求 Eveland token即可聊天。
2. local loopback `localDev()` Agent 不请求 Eveland token即可聊天。
3. `httpBasic()` Agent 使用标准 Basic challenge/credential；Eveland Identity不参与。
4. `evelandIdentity()` Agent 在无 Caller Token 时返回 Eveland-owned authentication continuation。
5. 已有 Eveland Identity Session 时 continuation 无感完成。
6. 没有 Session 时由 Eveland 当前 active provider登录；v0 是 Internal。
7. Eveland签发统一 Project-audience Caller Token，Agent验签成功。
8. Agent根据 claims 执行业务授权并可返回 `403`；Eveland不做 Project分配。
9. `[evelandIdentity(), httpBasic()]` 和 `[evelandIdentity(), localDev()]` fallback不被 continuation破坏。
10. 浏览器客户端和 CLI 都能消费同一 interaction shape。

### 6.3 Identity provider

1. 一个实例只能启用一个 Agent-user Identity Provider。
2. Internal Provider 保持现有流程。
3. Provider实现通过通用 resolved identity/finalization边界接入。
4. Caller Token不泄露 provider credential。
5. 将来替换为金数据 OIDC时，Agent和客户端协议不变。

## 7. 建议实施顺序

1. 在两个 dirty worktree 创建分支，保存当前状态。
2. 先在 Eveland 用测试固定新的 `/agent-catalog` contract。
3. 将现有 Catalog SQL从 Identity/grant 解耦。
4. 删除 Realm → Project grant API、UI、Store和 schema，生成新 migration。
5. 更新 spec/README，使产品真相与代码一致。
6. 为 Agent route authentication 写最小协议 contract，先覆盖浏览器和 CLI所需的 interaction shape。
7. 实现 `evelandIdentity()` continuation，同时保护多-auth fallback。
8. 更新 EveChats：点击只 lazy upsert，challenge 后才取得 Caller Token。
9. 跑跨仓库端到端闭环。
10. Agent Catalog 验收完成后，再进入 Connections provider-neutral设计。

不要把 GitHub/Linear Eve Connection 的 `authorization.required` runtime state machine提前搬进
Agent route auth。两者可以共享 challenge presentation shape，但生命周期、transport和安全边界不同。

## 8. 必须阅读和参考

Eveland：

1. `AGENTS.md`
2. `docs/spec.md`
3. `README.md`
4. `.plans/2026-07-13-gateway-observability-handoff.md`
5. `.plans/2026-07-17-agent-auth-rewrite-handoff.md`
6. 本文件
7. `packages/sdk/src/auth.ts`
8. `packages/identity-broker/src/index.ts`
9. lockfile 中 Eve 0.27.6：
   - `dist/src/public/channels/auth.d.ts`
   - `dist/src/public/channels/auth.js`
   - `dist/src/protocol/message.d.ts`
   - `dist/src/public/connections/errors.d.ts`

EveChats：

1. 仓库自身的 `AGENTS.md`（如有）
2. `README.md`
3. `docs/local-development.md`
4. `src/identity/client.ts`
5. `src/eve/auth.ts`
6. `src/app/api/chats/eve-proxy.ts`
7. `src/components/agent-catalog.tsx`
8. 当前 dirty diff 和相关测试

`2026-07-17-agent-auth-rewrite-handoff.md` 中关于 Playground Agent Connection provider-neutral
设计仍然有效；其中 3.5 节的 Realm → Project grant 和 managed web-chat假设已被本文件替代。

## 9. 验证与交接要求

按仓库 `AGENTS.md` 要求测试优先。至少运行：

```bash
# Eveland focused tests
pnpm --filter @evelandhq/core exec vitest run src/source.test.ts
pnpm --filter @evelandhq/api exec vitest run src/identity-routes.test.ts
pnpm --filter @evelandhq/identity-broker test
pnpm --filter @evelandhq/db test

# Eveland baseline
pnpm test
pnpm typecheck
pnpm build

# EveChats
pnpm test
pnpm typecheck
pnpm build
```

根据最终文件位置调整 focused test 命令。数据库 migration 还应通过实际 Postgres migration路径。

最终人工闭环至少包含：

```text
Eveland API + Gateway + Worker + Web
→ 部署 eveChannel Agent
→ EveChats读取 /agent-catalog
→ lazy upsert并打开
→ 根据 Agent route auth进行交互
→ evelandIdentity需要时进入 Eveland continuation
→ Internal Provider登录
→ Caller Token
→ 第一条消息成功
```

交接时必须准确报告实际运行了哪些测试、哪些未运行，不得把未执行的浏览器闭环写成已验证。

## 10. 2026-07-28 实施与验收记录

本计划的 Agent Catalog v0 和 Agent 入站认证 continuation 已完成：

- Eveland 使用独立公共 `GET /agent-catalog` 投影，不再依赖 Identity Realm 或
  Realm → Project grant。
- Realm → Project grant 的 schema、Store、API 和设置 UI 已删除，并通过新增
  `0031_fancy_wild_child` migration 删除旧表。
- `0032_agent_catalog_capability_backfill` 会为既有 Source Revision 中显式导出标准
  `eveChannel()`、但尚无 capability 元数据的记录回填 `eveChat=true`；它不按 Eve
  版本推断 Catalog membership，也不会覆盖显式 capability 值。
- `evelandIdentity()` 通过标准 `WWW-Authenticate` Bearer challenge 声明 Eveland
  continuation，同时保留后续 AuthFn 的有序 fallback。
- Gateway 原样转发 Agent 的 `401` 和 challenge；EveChats 只在收到匹配当前
  issuer/project 的 Eveland challenge 后取得 Caller Token 并重试原请求。
- EveChats Catalog 点击只做 server-authoritative lazy upsert；App Token、Caller Token
  和 Agent 自有 credential 的边界保持独立。
- EveChats `/agents` 和 Catalog Agent 打开路径只读取 Catalog并使用签名的 HttpOnly
  浏览器会话维护匿名聊天所有权；`/` 打开当前 scope 最新的 Chat，无历史时回退到
  `/agents`，Chat 历史统一按最新优先排序。未登录访问、创建 Chat 和普通 Agent 请求不会申请 App Token 或启动
  Eveland 登录。已有 Identity Session 时才使用 App Token 合并读取 identity-scoped
  history；只有 Agent challenge 会启动 Caller Token continuation。
- EveChats `0006_ambitious_shen` migration 为 Chat 增加匿名浏览器 owner；同一浏览器
  可以在不登录时安全读取和继续自己的历史，其他匿名会话不能仅凭列表 API看到这些 Chat。
- Caller Token 重试再次收到 `401` 时不会重复启动认证流程。
- EveChats 在一次页面生命周期内只启动一次 Identity 登录导航，避免 Safari 等导航
  提交较慢的浏览器对同一 Agent challenge 重复创建 continuation state并形成跳转风暴。
- Eveland Identity 与 EveChats 主机名相同（本地为 `localhost`、端口不同）时，
  Identity Session、App Token、Caller Token 和 logout 浏览器请求通过同源
  `/identity/*` 路径代理到 Eveland；顶层登录与 Agent continuation 仍直接进入
  Eveland。这样 Safari 不再依赖跨端口 credential request 暴露 Identity Cookie，也
  不会在返回聊天页后重新开始整页认证循环；不同主机名的现有生产请求方式保持不变。
- EveChats 创建 Chat 后只发起一次 App Router `push`，不再紧接着启动并发
  `refresh`。后者会在首条消息的 Identity challenge 导航时被 Safari 中断，并触发
  Next 的 RSC fallback 整页导航回 Chat，从而覆盖登录跳转并无限重放 pending message。
- Eve SDK 的 `onFinish` 在成功和错误时都会触发；EveChats 现在仅在 snapshot 回到
  `ready` 时刷新 Chat。401/challenge 或认证跳转的 `error` snapshot 不再启动 RSC
  refresh，因此 Safari 的登录导航不会被失败的 RSC fallback 覆盖。
- Identity Session Cookie 保持 `Path=/identity`，避免新旧同名 Cookie 并存导致登录循环。

实际验证：

```text
Eveland: pnpm test       passed
Eveland: pnpm typecheck  passed
Eveland: pnpm build      passed
EveChats: pnpm test      passed (194 tests)
EveChats: pnpm typecheck passed
EveChats: pnpm build     passed
Both worktrees: git diff --check passed
Real Postgres: pnpm --filter @evelandhq/api db:migrate passed
```

真实浏览器闭环使用 `proj_UhibPXW1QG`（`eveland-identity-e2e-inline`）完成：

```text
Eveland API + Gateway + Worker + Web
→ EveChats 读取 /agent-catalog
→ lazy upsert并打开
→ App Token 首次请求收到 Eveland challenge
→ Internal Provider 登录
→ Caller Token
→ 原消息自动重试并收到 Agent 响应
```

另一个 Catalog Agent 还验证了无需 Caller Token 的 local-development fallback。
测试服务和 `eveland-identity-e2e-inline` 保持运行，供后续人工检查。Connections
provider-neutral 设计仍是本计划完成后的独立下一阶段，没有提前并入本次实现。
