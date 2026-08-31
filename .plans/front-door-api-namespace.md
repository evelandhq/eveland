# 前门命名空间收敛：/api 对 /internal，注册即契约

状态：已实施（2026-08-31，两个 PR 均已提交；identity-e2e 以生产形状穿前门验证通过）。
本文档自包含，不依赖其他上下文。承接端口重设计 Phase 2（#421 单前门）。
两个平台 PR 顺序实施：PR 1 修复公开契约面回归（生产已坏，优先），PR 2 完成 Dashboard
面拉平与前门终态。待办：npm `eveland` 0.6.0 发版（用户手动 2FA）与 dawnchat 跟进。

**终态**：前门只有两条 verbatim 规则；API 进程顶级命名空间只有四个；全系统每个端点
只有一个路径写法（SDK、API 注册、前门、curl、文档完全同构），没有白名单表、没有
strip/改写、没有过渡 alias。

```text
# 前门（:17300，Host 路由的 agent 流量先行分走，不变）
/.well-known/*   → API verbatim    # 协议面，位置由标准决定
/api/*           → API verbatim    # 产品公开面，API 注册即契约
其余             → Dashboard 页面

# API 进程（:17301 回环）
/api/*           # 公开面（浏览器方言：cookie/CORS/Caller Token）
/internal/*      # 机器面（服务凭证方言；前门不转发 → 公网从构造上不可达）
/.well-known/*   # 协议面（jwks.json）
/health
```

## 背景与动机

#421 把所有公开 origin 合并进前门后留下一个回归：前门路径表只放行 `/.well-known/*`、
`/api/auth/*` 和白名单 `/api/eveland/*`，其余落 Dashboard。但 API 在 issuer origin 上
锚定注册了 `/identity/*` 与 `/agent-catalog`，且 issuer 默认就是 `EVELAND_PUBLIC_ORIGIN`
（`app-identity-routes.ts` 的 fallback 链）。后果：

- `oidcRedirectUri = ${issuer}/identity/oidc/callback`（在 IdP 侧登记的回调）落到 Dashboard
  —— **真实 IdP 的 OIDC 登录在生产拓扑下已坏**；
- SDK（npm `eveland`，已发布至 0.5.0）生成的 `${issuer}/identity/login` challenge 同坏；
- 外部聊天客户端（dawnchat）的 identity 与 catalog 全部失效。

Lima 全绿的原因是测试盲区：`infra/integration/identity-e2e.mts` 把 issuer 钉在
`http://127.0.0.1:${apiPort}` 直连 API，整条链路从未穿过前门。

修复讨论没有停在"补一条 `/identity` 转发"，而是把命名空间问题一次收敛。

## 设计决策记录（为什么是这个形态）

1. **裸路径必须归 Dashboard**。API 路由注册在裸根（`/projects` 38 条、`/system` 17 条…），
   与 Dashboard 页面路由直接撞车，所以浏览器 API 流量需要前缀，这没得选。
2. **前缀是 `/api` 而不是 `/api/eveland` 隧道**。`/api/eveland` 是前门之前 web origin
   代理时代的遗物（#379 把 wildcard 换成 fail-closed 白名单以堵 #73），#421 只是把它
   原样抬进 gateway。API 把公开面**原生注册**到 `/api/*` 后，"注册即白名单"：
   `/internal` 留在根上，前门只转发 `/api/*`，机器面从构造上公网不可达——fail-closed
   不再依赖一张人工维护的表，#73 一类洞失去存在条件。
3. **verbatim，不做路径改写**（否决了"API 侧注册 `/eveland/*`、前门改写"方案）。
   公开/机器面的对照由 `/api` 对 `/internal` 承担；改写会让每个端点重新有两个名字，
   且恰好疼在生成绝对 URL 的最精密处（identity issuer URL、Better Auth basePath），
   代理层也从"原样转发"退化回"路径手术"（编码斜杠/双重解码 bug 面）。
4. **`/internal` 保持独立根命名空间**。它是机器面：gateway→API（identity broker、
   激活租约）、agent 内 scheduler hook→API（runtime secret + 签名一次性凭证）、
   dispatcher/collector 等。认证方言与浏览器面完全不同（无 cookie/CORS/CSRF 面），
   gateway 侧在任何 handler 之前结构性设门并终结 404。它是两条规则前门的承重墙。
5. **`/identity/*` 硬切到 `/api/identity/*`，不留 308**。旧路径经前门今天本来就是坏的，
   不存在需要保护的"旧路径正常工作"的部署形态；升级动作（SDK ≥0.6 + rebuild+promote）
   与 external cutover aftermath 同款、流程成熟。
6. **JWKS 留在 `/.well-known/jwks.json`**。`/.well-known` 前缀本身是 RFC 8615 协议约束
   （"只凭 origin、零配置可找到"，定义在 origin 根）；`jwks.json` 放那里虽是自家约定
   （无发现文档，消费方靠 SDK 派生或 env），但搬走是笔不对称赌注：省一行前门规则，
   赌上"将来发标准发现文档时 JWKS 要二次迁移"。两条规则对应两种主权：`/.well-known`
   归互联网标准，`/api` 归我们。
7. **`agent-catalog` 归 `/api/agent-catalog`，不进 `/.well-known`，不挂 identity 下**。
   它是活的运营投影（随 deployment 可路由状态变化），不是 origin 元数据；well-known 的
   惯用形态是小指针文档而非数据本体。也不挂 `/api/identity/` 下——它的安全模型刻意是
   "无 Session、人人同列表、Realm 不过滤"，路径挂 identity 下会暗示错误的认证边界。
   远期零配置发现走 `/.well-known/eveland` 指针文档（vendor 前缀），已记入 CLI tools
   计划作前置项，本轮不做。
8. **`/auth/session` 与 `/api/auth` 撞名清理**。`/api/auth/*` 是 Better Auth 挂载点
   （库默认 basePath，边界只放行 sign-in/email、sign-out、get-session 三端点）；
   `/auth/session` 是 eveland 自己的 principal 回显路由，撞名纯属意外。拉平后它会掉进
   Better Auth wildcard，改名为 `/api/members/me`。白名单里 `auth` 与 `api/auth` 双子树
   （及 web 侧 `/api/eveland/api/auth/...` 双重 api 丑路径）随隧道一并消亡。

## 路径迁移总表

| 旧（公开 origin / API 注册）                                               | 新（两侧同一写法）                  | 备注                                        |
| -------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------- |
| `/identity/session` 等 7 条                                                | `/api/identity/…`                   | cookie Path、oidcRedirectUri、CORS 清单同步 |
| `/identity/internal/continue`                                              | `/api/identity/continue`            | 顺手去掉误导性 "internal"；web shim 删除    |
| `/agent-catalog`                                                           | `/api/agent-catalog`                | SDK 不生成此 URL，硬切最便宜                |
| `/auth/session`                                                            | `/api/members/me`                   | 避让 Better Auth wildcard                   |
| `/api/auth/*`（Better Auth）                                               | 不变                                | basePath 天然合规                           |
| `/.well-known/jwks.json`                                                   | 不变                                | 协议面                                      |
| `/api/eveland/<subtree>/*` → strip                                         | `/api/<subtree>/*` 原生注册         | 11 个子树平移；隧道/白名单/strip 退役       |
| API 根散路由 `/sessions` `/usage` `/schedule-runs` `/x` `/protected-probe` | 逐个归队 → `/api`、`/internal` 或删 | 今天即公网不可达，迁移时清点                |

SDK 侧：`packages/sdk/src/auth.ts` challenge URL → `${issuer}/api/identity/login`；
JWKS 派生 `${issuer}/.well-known/jwks.json` 不变。issuer 本身仍是裸 origin，不迁移
（(issuer, projectId) 身份契约不动）。

---

# PR 1：公开契约面修复（identity + catalog）

修的是生产回归，优先合并。中间态前门规则临时为 5 条（`/.well-known`、`/api/auth`、
`/api/identity`、`/api/agent-catalog` verbatim + `/api/eveland` 隧道），PR 2 收敛到 2 条。

- **API**：`app-identity-routes.ts` 全部公开路由迁 `/api/identity/*`（`internal/continue`
  → `continue`）；`eveland_identity` cookie Path → `/api/identity`（旧 cookie 自然失联，
  用户重登录，无害）；`oidcRedirectUri` 随 issuer 派生变为 `${issuer}/api/identity/oidc/callback`；
  `app-agent-catalog-routes.ts` → `/api/agent-catalog`；`app.ts` 的
  `identityBrowserCorsPaths` 更新。
- **前门**：`packages/core/src/front-door.ts` 新增 `/api/identity/*` 与 `/api/agent-catalog`
  （exact）verbatim 规则。
- **SDK**：`packages/sdk/src/auth.ts` challenge URL 改 `/api/identity/login`（workspace 内
  同 PR 原子切换；npm 发版见后）。
- **web**：删 `apps/web/src/app/identity/internal/continue/` shim 与
  `lib/identity-continuation.ts`（它重定向浏览器到回环 API 地址，#421 后对非本机浏览器
  本来就坏）。
- **测试**：
  - 新 pin 测试：`identityBrowserCorsPaths` 逐条经 `classifyFrontDoorPath` 归 `api`
    （API 的浏览器公开面清单与前门表结构性耦合，修类不修例）；
  - `identity-e2e.mts` 的 issuer 从裸 API 端口改为**穿 gateway 前门**的公开 origin，
    整条 OIDC 链路（login → callback → caller-tokens → JWKS）以生产形状验证——这是
    本次回归的直接验证钥匙，若 harness 改造过重可降级为独立前门集成测试，但目标不变。
- **docs（en+zh 同步）**：`operations/upgrades.md` 破坏性条目（见"发布与部署"）；
  `reference/identity.md`、`operations/security.md`、`reference/environment-variables.md`、
  `reference/design/agent-catalog.md` 路径更新。spec.md 为原则层，预计不动（有版本字面量
  守卫测试，勿触）。

# PR 2：Dashboard 面拉平 + 前门终态

- **API**：白名单 11 个子树（agent-auth、agent-connections、git-credentials、invitations、
  members、password-reset、platform、profile、projects、source-preflights、system）原生
  注册到 `/api/<subtree>/*`；`/auth/session` → `/api/members/me`；根散路由清点归队。
- **前门**：`classifyFrontDoorPath` 收敛为两条 verbatim 规则；`BROWSER_API_PREFIX`、
  `BROWSER_API_SUBTREES`、strip、`blocked` 目标全部退役；gateway 代理不再做路径手术。
- **web**：fetch 前缀 `/api/eveland/` → `/api/`（`client-api.ts`、`api-transport.ts`、
  auth-api 等；`/api/eveland/api/auth/*` 双重路径消亡）；`next.config.ts` rewrites 收敛为
  单条 `/api/:path* → ${api}/api/:path*` verbatim；`next-config.test.ts` 随之简化。
- **architecture-tests**：新 ratchet——API 顶级命名空间只允许 `/api`、`/internal`、
  `/.well-known`、`/health` 四个，杜绝第五类再生。
- 全量 Lima 梯队 + `pnpm -r --no-bail test`（含 build，镜像 CI 干净起点）。

# 发布与部署（平台 PR 合并后）

1. **npm `eveland` 0.6.0 发版**（手动、2FA，用户执行）：challenge 路径变更，pre-1.0
   minor 即破坏性变更，changelog 写明。
2. **upgrades.md 条目**（随 PR 1 落）：
   - identity/catalog 路径迁至 `/api/*`；agent 需 `eveland` ≥0.6 并 **rebuild+promote
     全部项目**（≤0.5 烤入的 challenge URL 在新平台上 404，与 #421 前经前门同样是坏的，
     无额外损失）；
   - OIDC 安装需在 IdP 侧把 redirect URI 重登记为 `<issuer>/api/identity/oidc/callback`；
   - 外部聊天客户端配置的 catalog/identity 地址同步更新。
3. 部署本体即常规 redeploy + promote。

# dawnchat 跟进（另仓库，平台部署后）

- 公共入口指向 `:17300`（`EVELAND_PUBLIC_ORIGIN` 单值收敛，issuer/JWKS/内部 origin 派生
  可选覆盖——沿用其分析的集中配置解析器方案）；
- identity 路径 → `/api/identity/*`，catalog → `/api/agent-catalog`；
- 显式配置 `EVELAND_IDENTITY_ALLOWED_ORIGINS`（#421 起无 `localhost:3010` 默认值，
  空 = 拒绝所有浏览器 origin，这是有意决策不回退）；
- issuer 不变（origin 迁移时按 upgrades.md 保留旧 issuer），其 `(issuer, projectId)`
  managed Agent 身份与 App Token 聊天过滤不受影响。

# 悬置与远期

- `/.well-known/eveland` 发现指针文档（`{ agentCatalog, identityIssuer, version }`，
  vendor 前缀）：待 CLI tools（curl 前门 + 导游 agent）或开源后陌生安装接入成为真需求时
  实施，已记入 CLI tools 计划。
- 远期若发标准 OIDC 发现文档，`/.well-known/openid-configuration` 在 issuer 根，
  `jwks_uri` 从中引用——当前 JWKS 位置已按此预留，无需再迁。
