# Gateway、Session Observability 与版本化 Deployment 实现交接

> 面向后续实现者（Claude Code）的工程交接文件。
>
> 基线：`a21fd74`（`Merge pull request #18 from evelandhq/worktree-feat-systemd-default`）
>
> 本文件记录 2026-07-10 至 2026-07-13 的架构讨论结论。除“Required investigation”明确标出的项目外，不要重新发散已确定的产品和架构边界。

## 0. 先读这些文件

开始实现前，按顺序阅读：

1. `docs/spec.md`
2. 本文件
3. `docs/deploy/linux.md`
4. `apps/api/src/app.ts`
5. `apps/api/src/db/schema.ts`
6. `apps/worker/src/jobs/process.ts`
7. `apps/worker/src/runtime/{types,docker,systemd}.ts`
8. `apps/worker/src/runtime/sandbox-inject.ts`
9. 安装的 Eve 0.22.1 文档：
   - `eve/docs/guides/auth-and-route-protection.md`
   - `eve/docs/guides/hooks.md`
   - `eve/docs/concepts/sessions-runs-and-streaming.md`

`docs/spec.md` 仍是产品真相源。本文件补充 Gateway、全链路 Session 观测和版本化 Deployment 的实现设计；若两者发生冲突，先更新 spec 并说明原因，不要静默偏离。

---

## 1. 为什么要做这次重构

当前 token/session 采集只存在于 Playground 路径：

```text
POST /projects/:projectId/playground
  -> API 创建 Eveland Session
  -> API 请求 Eve POST /eve/v1/session
  -> API 消费 Eve NDJSON stream
  -> API 解析 step.completed usage
  -> API 写 Session/Event/Usage
```

因此以下入口完全绕过 Eveland 的 Session 记录：

- 直接访问受管 Agent 的 loopback 端口，例如 `http://127.0.0.1:41001`；
- Eve schedule；
- Slack、Discord 等 Channel；
- custom webhook/channel；
- Agent 内部触发和 subagent；
- 未来通过公开 Agent URL 直接调用 Eve API 的客户端。

这违反 `docs/spec.md` 中 Sessions 应覆盖 Playground、Cron、Webhook、Channel、API 的约定。

当前代码还存在几个会阻碍后续演进的结构问题：

- `apps/api/src/app.ts` 同时承担控制 API、Playground proxy、Eve protocol client、stream collector 和 usage projector；
- `apps/worker` 直接依赖 `@eveland/api/store` / `@eveland/api/types`，形成 App -> App 依赖；
- 当前 worker 启动新 Deployment 前会停止旧 Deployment，并复用旧 host port，无法同时保留 preview/candidate/production Deployment；
- 当前 Playground 将 `turn.completed` 当作 terminal，并在一次回复后把平台 Session 标记为 completed；Eve 的真正当前-turn边界是 `session.waiting | session.completed | session.failed`；
- 当前 `sessions` / `session_events` 模型无法自然表达 root Agent + 多个 subagent session tree。

---

## 2. 已确定的架构决策（Do not reopen）

### 2.1 继续使用一个 monorepo

不拆仓库，不引入 Kubernetes，不引入消息中间件。目标仍是 single-box self-hosted。

### 2.2 最终 App 结构

```text
apps/
  web/                 管理界面
  api/                 控制面 API，并在当前阶段启动 embedded collector
  gateway/             公共 Agent 数据面：Host 路由、限流、透明流式代理
  worker/              Source、Build、Deploy、Restart、Health reconcile
```

Collector 是独立的逻辑组件，但当前阶段不单独运行 `apps/collector`。它以独立 package 实现，由 API 进程启动。未来需要独立扩容时，再添加一个只调用同一 package 的 `apps/collector/src/main.ts`。

### 2.3 最终 Package 结构

```text
packages/
  core/                contracts + Eve wire protocol + 通用领域逻辑
  db/                  Drizzle schema、migrations、Store/Repository、mappers
  session-collector/   outbox、ingest、projector、claim/lease、health
  agent-observer/      构建时注入 Eve observer Hook
  sandbox-bwrap/       保持独立、可发布的 Eve SandboxBackend
```

`contracts/`、`eve-protocol/`、现有 `shared/` 合并为 `packages/core/`，但必须使用显式 subpath exports，不能提供一个把 browser-safe 与 Node-only 模块全部 re-export 的根 barrel。

建议 exports：

```text
@eveland/core/contracts
@eveland/core/eve
@eveland/core/ids
@eveland/core/schedules
@eveland/core/source
@eveland/core/server/archive
@eveland/core/server/secrets
@eveland/core/server/runtime-command
```

依赖方向固定为：

```text
apps -> packages
session-collector -> core + db
db -> core
agent-observer -> core/contracts（只在构建/生成阶段）
core -> 不依赖其他 Eveland package
apps -X-> apps
```

### 2.4 Gateway 与 Agent auth 的边界

Gateway **不是应用级 Identity Provider**。Eve Agent 自己的 `agent/channels/eve.ts` 继续拥有 route auth；Gateway 必须透明保留：

- `Authorization`
- `Cookie`
- `Origin`
- Eve request/response headers
- NDJSON response body，不得缓冲成完整 body

Gateway 只负责：

- canonical Host 校验和 Project/Deployment 路由；
- endpoint 是否启用；
- TLS 后的可信代理边界；
- request size、基础 rate limit、审计；
- 删除外部调用者伪造的 `Forwarded` / `X-Forwarded-*`，再从可信连接重建；
- 删除所有保留的 `X-Eveland-*` 外部输入，仅由平台重新签发。

**绝不能**因为 upstream 是 `127.0.0.1:<port>` 就把转发后的 Host 改成 `127.0.0.1` 或 `localhost`。Eve `localDev()` 根据请求 URL hostname 接受 `localhost`、`*.localhost`、`127.0.0.0/8` 和 `::1`；错误重写 Host 会把公网请求变成 local-dev 身份，形成认证绕过。

对公网请求，Gateway 必须把经过验证的 canonical public Host 传给 Eve。对内部 Playground 调用，允许一个单独的、经过 Eveland 管理员认证的 privileged path 使用 loopback Host，从而获得 Eve local-dev 身份；该路径不得从公开 Gateway 到达。

### 2.5 Agent 原始端口是 private upstream

生产环境只公开 Traefik 的 80/443。Agent 继续绑定 `127.0.0.1:<dynamicPort>`，但端口不显示为产品 URL，也不由 Traefik 直接暴露。

```text
Internet
  -> Traefik
  -> Gateway
  -> 127.0.0.1:<agentPort>
```

Traefik 只配置一条 wildcard route 到 Gateway，不为每个 Project/Deployment 动态生成 Traefik 配置。

### 2.6 开发环境使用 `*.localhost`

Gateway 默认监听一个固定开发端口（建议 `4080`）：

```text
<routingKey>.agent.localhost:4080
d-<deploymentKey>--<routingKey>.agent.localhost:4080
```

现有 Project ID 包含 `_`，不能直接作为 DNS-safe hostname。Project 必须新增不可变、全局唯一、只包含 `[a-z0-9-]` 的 `routingKey`，例如 `p-k7m4x2`。

开发阶段不要求运行 Traefik。Gateway 直接根据 Host 查数据库。生产环境对应：

```text
<routingKey>.agents.example.com
d-<deploymentKey>--<routingKey>.agents.example.com
```

使用单层 hostname 是为了让一个 `*.agents.example.com` wildcard certificate 覆盖稳定地址、Deployment preview 地址和命名 alias。

### 2.7 Observer/Collector 采用 push-first，不依赖 Eve route auth

Collector 的主链路不是“发现 sessionId 后 GET Eve stream”。如果 Agent 自定义 route auth 且没有 `localDev()`，平台无法安全地读取 stream；保存最终用户 Authorization 也不可接受，且 Cron/Channel/subagent 没有对应 HTTP credential。

权威链路为：

```text
Eve accepted event
  -> platform-injected Hook
  -> durable local filesystem outbox
  -> embedded Collector
  -> PostgreSQL
```

Eve stream pull 可以作为在内部认证可用时的 optional reconciliation，但不能成为正确性前提，第一阶段也不需要实现它。

### 2.8 Observer 不得影响 Agent 可用性

Eve Hook 抛错会使 turn/session 失败。因此 observer Hook 的所有 I/O 错误必须捕获并限频记录；默认策略是 Agent 可用性优先，观测进入 degraded 状态。不得 fail closed。

### 2.9 Session 是 root conversation，subagent 是 node

平台数据模型分两层：

```text
Session
  root conversation，UI、A/B variant、总 usage 的聚合单位

SessionNode
  每个 Eve sessionId 一个节点：root Agent 和每个 subagent 各一条
```

`SessionNode` 的身份约束是 `unique(projectId, eveSessionId)`，不是 `unique(deploymentId, eveSessionId)`。Durable Eve Session 可能跨 redeploy 延续；每条 event 另行记录 `observedDeploymentId`。

### 2.10 版本化 Deployment：immutable target + mutable route

借鉴 Vercel/Cloudflare 的语义，但不复制其基础设施：

- Release 是不可变构建产物；
- Deployment 是一个可独立启动/停止、拥有 preview URL 的版本目标；
- stable Project route / named alias 是可变路由；
- route target 可以是一个 Deployment 100%，或两个 Deployment 的 A/B 权重；
- 不考虑 replicas；每个 Deployment 最多一个运行进程；
- DNS/CNAME 永远只到 Gateway，不直接选择 Deployment；
- 指定版本测试使用 Deployment preview URL。

A/B 必须按 root Session 固定版本，不能逐请求随机：

```text
first POST /eve/v1/session
  -> affinity bucket 选择 Deployment
  -> Eve 返回 eveSessionId
  -> Gateway 持久化 SessionBinding(eveSessionId -> deploymentId)

POST /eve/v1/session/:sessionId
GET  /eve/v1/session/:sessionId/stream
  -> 永远按 SessionBinding 回到同一 Deployment
```

### 2.11 Deployment 保留策略

“最近 3 个 Deployment”是默认 artifact/rollback 保证，不等于三个进程永久运行：

- Deployment metadata/history：长期保留；
- Release artifact：至少保留最近 3 个，可配置；
- running process：只保留 route target、draining session 或短期 warm rollback 需要的 Deployment；
- production + active candidate + previous production 是常见的最多三个 warm target；
- 仍有非终态 SessionBinding 的 Deployment 不得直接删除 artifact；可保持运行、drain，或在 continuation 时 cold start；
- 删除/归档需要明确的 session retention/drain policy，不能仅按“不是最近三个”判断。

---

## 3. 目标运行拓扑

```text
                            +----------------------+
Browser / API Client -----> | Traefik (production) |
                            +----------+-----------+
                                       |
                                       v
                            +----------------------+
                            | apps/gateway         |
                            | public data plane    |
                            +----------+-----------+
                                       |
                         Host/Route/Binding lookup
                                       |
                                       v
                            +----------------------+
                            | Eve Deployment       |
                            | 127.0.0.1:41xxx      |
                            +----------+-----------+
                                       |
                              injected observer hook
                                       |
                                       v
                        /var/lib/eveland/observer/...
                                       |
                                       v
                     +----------------------------------+
                     | apps/api                         |
                     | control API + embedded collector |
                     +----------------+-----------------+
                                      |
                                      v
                                  PostgreSQL

apps/worker (host/root under systemd)
  -> source import
  -> release preparation
  -> observer/sandbox injection
  -> build/start/stop/reconcile
  -> never serves public traffic
```

---

## 4. Gateway 详细契约

### 4.1 Route kinds

统一建模为 Agent Route：

```text
project route
  <routingKey>.agents.example.com
  stable production/A-B endpoint

deployment route
  d-<deploymentKey>--<routingKey>.agents.example.com
  immutable preview endpoint, exactly one deployment at weight 100%

named alias
  canary--<routingKey>.agents.example.com
  staging--<routingKey>.agents.example.com
  mutable route, one or two targets
```

未知 Host 返回 404；disabled route 返回 404；route 存在但没有 running target 返回 503。不要通过错误响应泄露 disabled/private Project 的存在。

### 4.2 Host resolution

Gateway 必须：

1. 去掉端口并 lowercase hostname；
2. 拒绝不属于允许 base domain 的 hostname；
3. 从完整 hostname 查 `agent_routes`，不要接受客户端传入 projectId/deploymentId header；
4. 解析 route target；
5. 按 SessionBinding 或 affinity 选择 Deployment；
6. 检查 Deployment status / runtime address；
7. 透明代理全部 method/path，包括 custom channel routes；
8. 原样覆盖 `/eve/*` 与 `/.well-known/workflow/*`，不得只代理 `/eve/*`。

### 4.3 Proxy header rules

Forward：

- `Authorization`
- `Cookie`
- `Content-Type`
- `Accept`
- `Origin`
- Eve protocol headers
- 其他 end-to-end headers

Strip：

- `Connection`
- `Keep-Alive`
- `Proxy-Authenticate`
- `Proxy-Authorization`
- `TE`
- `Trailer`
- `Transfer-Encoding`
- `Upgrade`（除非后续明确支持 WebSocket）
- 外部 `Forwarded` / `X-Forwarded-*`
- 外部 `X-Eveland-*`

Rebuild：

- validated canonical `Host`
- `Forwarded` / `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host`
- internal correlation/trace headers

Node fetch 代理 request body 时不能先 `.text()` / `.json()`；保留 streaming body，并处理 Node `duplex: "half"` 要求。Response 直接返回 upstream Web `ReadableStream`，不要缓冲 NDJSON。

### 4.4 Application auth invariants

必须有集成测试证明：

1. `foo.agent.localhost` 能被 Eve `localDev()` 接受；
2. production hostname 在 Agent 没有接受对应 credential 时得到 401；
3. 外部请求伪造 `Host: localhost` / `X-Forwarded-Host: localhost` 无法绕过；
4. Gateway 没有消费或替换 Agent 的 `Authorization`；
5. Cookie/Set-Cookie 正常穿透；
6. public Host 经过 upstream `127.0.0.1` 后，Eve 看到的仍是 canonical public Host。

### 4.5 Internal Playground mode

Playground 是管理员开发工具，不等同于真实终端用户调用。当前 Web 以 `/projects/:projectId/playground/eve/*` 代理 Eve canonical session protocol；API 在一个页面会话中只创建一个平台 Session，Gateway 再通过仅 private network 可达且需要 service credential 的 `/internal/projects/:projectId/playground/eve/*` 路径转发 initial、continuation 和 stream 请求。Gateway 使用 loopback Host 获得 Eve local-dev principal，并用 SessionBinding 固定后续请求的 Deployment。

每次打开或刷新页面都从一个新的空白会话开始；页面内连续 turn、HITL 回答和外部授权恢复保留同一个 Eve Session。UI 实时展示 conversation、reasoning、tool state 和 input request，允许停止生成，并接受最多 4 个、单个 5 MiB、合计 10 MiB 的图片/PDF/文本/代码附件。Playground 不持久化 raw reasoning 或上传文件，Sessions/usage 的权威采集仍由 Observer/Collector 完成。

后续可增加“Test with real auth”模式，允许管理员显式传入测试 Authorization，并使用 canonical public Host；不要伪造最终用户身份。

### 4.6 Gateway discovery/provenance

Gateway 对 canonical Eve route 的 initial session POST：

1. 选择 target Deployment；
2. 代理请求；
3. 从 `x-eve-session-id` 或 response JSON 读取 `eveSessionId`；
4. 在返回客户端前写入 SessionBinding；
5. 记录 route、deployment、experiment、variant、remote IP、request ID、平台 affinity source；
6. Hook/Collector 随后用同一 `(projectId, eveSessionId)` 幂等合并 runtime metadata。

continuation 和 stream path 已包含 sessionId，优先查 SessionBinding，不再重新按权重选择。

直接访问 private port 的 HTTP Session 没有 Gateway provenance。Observer 仍会采集，平台将其标记为 `direct_http` / `unattributed_http`，而不是丢弃。

### 4.7 A/B affinity

Route target weights 使用整数总和 10000，当前只支持最多两个 target。

默认 affinity：

- Browser：Gateway 签发的 HttpOnly/signed version-affinity cookie；
- API：可选 `X-Eveland-Version-Key`，只用于 bucket，转发前删除；
- 无 key：为新 root session 生成随机 affinity value；
- Deployment preview route：无权重选择，固定 100% target。

Bucket 使用稳定 hash：

```text
bucket = hash(routeId + policyRevision + affinityKey) % 10000
```

一旦拿到 Eve sessionId，SessionBinding 高于 cookie/header/当前权重。权重调整不能移动已存在 Session。

---

## 5. Observer 与 filesystem outbox

### 5.1 注入位置

构建 Release 时注入保留文件：

```text
agent/hooks/__eveland_observer.js
```

并递归处理每个拥有独立 Agent root 的 directory-form subagent。不要修改 source repository；只修改 prepared release tree。若用户源码已经包含同名保留文件，构建失败并给出 actionable error，不要静默覆盖。

Observer module 必须自包含，只依赖 Node built-ins 和用户项目已经拥有的 `eve/hooks`。部署时不能要求用户 package.json 添加 `@eveland/*` 依赖。

### 5.2 Required investigation: subagent coverage

在实现注入器前，先用 Eve 0.22.1 建立 fixture 并验证：

- root Agent hook 能看到哪些 root events；
- directory-form subagent 独立 hook 能看到哪些 events；
- file-form subagent 是否拥有可注入 hook slot；
- parent stream 的 `subagent.child_event` 是否足以覆盖 file-form subagent；
- local 与 remote subagent 的 metadata/parent relationship。

测试结果必须写进代码注释/测试名称。如果 Eve public extension surface 无法覆盖 file-form subagent，不要 patch Eve compiled internals；明确记录限制，或先向 Eve 增加支持。不得在没有真实 fixture 证明时宣称“全部 subagent 已覆盖”。

### 5.3 事件过滤

默认采集 finalized/lifecycle events：

- `session.started`
- `turn.started`
- `message.received`
- `message.completed`
- `reasoning.completed`（默认可关闭，见 privacy）
- `actions.requested`
- `action.result`
- `input.requested`
- `authorization.required/completed`
- `subagent.*`
- `step.started/completed/failed`
- `turn.completed/failed`
- `session.waiting/completed/failed`
- compaction lifecycle

默认忽略高频 delta：

- `message.appended`
- `reasoning.appended`

不要把 Secret 注入 observer envelope。Tool input/result 和消息内容可能包含敏感数据，必须为后续 retention/redaction 留出字段；默认不保存 reasoning 内容是推荐产品策略。

### 5.4 Envelope schema

`@eveland/core/contracts` 定义 versioned Zod schema。最少包含：

```ts
type ObserverEnvelopeV1 = {
  schemaVersion: 1;
  observerEventId: string;
  eventFingerprint: string;
  deploymentId: string;
  eveSessionId: string;
  parentEveSessionId: string | null;
  sourceSequence: number;
  agent: {
    id: string | null;
    name: string | null;
    nodeId: string | null;
  };
  channelKind: string | null;
  eventAt: string;
  event: unknown;
};
```

Project identity由 Collector 根据 deploymentId 从数据库获得；即使 envelope 带 projectId 也不能信任它。

- `observerEventId`：一个具体 outbox record 的稳定 ID，用于文件重放幂等；
- `eventFingerprint`：基于 `eveSessionId + event.meta.at + canonical event JSON` 的稳定 hash，用于识别 runtime replay 的语义重复；
- `sourceSequence`：仅用于同一个 `(deploymentId, eveSessionId)` 的排序；允许出现 gap。

Usage 另有语义唯一键 `(sessionNodeId, turnId, stepIndex)`，不得因为 envelope 重放重复累计 token。

### 5.5 Outbox layout

生产默认：

```text
/var/lib/eveland/observer/
  <projectId>/
    <deploymentId>/
      sessions/
        <safeSessionDigest>/
          next-sequence
          000000000001-<observerEventId>.ready.json
          000000000002-<observerEventId>.ready.json
```

不要把原始 eveSessionId 直接用作目录名；使用 digest，真实 ID 保存在 envelope。

每个 session 的 Hook 写入通过进程内 Promise queue 串行化：

1. 读取/初始化 `next-sequence`；
2. 先原子预留下一个 sequence（允许 crash 留 gap）；
3. 将 envelope 写到同目录临时文件；
4. fsync/close（实现按性能测试决定是否每条 fsync，但 rename 必须同 filesystem）；
5. rename 为 `.ready.json`；
6. 捕获全部异常并 rate-limit log，绝不向 Eve 抛出。

Collector claim：

```text
*.ready.json
  -> atomic rename *.processing.<collectorId>.json
  -> validate
  -> DB transaction
  -> delete
```

进程崩溃后，超过 lease age 的 `.processing.*` 文件恢复为 ready。坏文件移动到 quarantine，并把 collector 标记 degraded；不要无限 hot-loop 同一个坏文件。

### 5.6 systemd permissions

Worker 在 start 前创建 deployment outbox dir，授予 Deployment service user 对自己的目录读写，并把该目录加入 transient unit 的 `ReadWritePaths=`。不要给 Deployment 写整个 `/var/lib/eveland/observer` 的权限。

添加 build/deploy self-check：以实际 deployment user 写入、rename、删除 probe envelope。仅 `/eve/v1/health` 成功不足以证明 observer outbox 可用。

### 5.7 Docker dev path mapping

Docker runtime 也必须验证，不得只实现 systemd。当前 containerized worker 通过 host Docker socket 创建 Agent container；Docker bind source 路径由 host daemon 解析，不能盲目把 worker container 内部的 `/workspace/...` 当作 host path。

实现时引入清晰的 host data dir 配置（名称可采用 `EVELAND_HOST_DATA_DIR`）：

- native/systemd：默认等于 `EVELAND_DATA_DIR`；
- containerized Docker worker：显式配置为 workspace 在 Docker host 上的绝对路径；
- Agent container 将 deployment outbox host dir bind 到固定内部路径；
- API/embedded collector 必须看到同一宿主目录；
- compose、README、deploy docs 必须同步更新。

不要在没有真实 Docker smoke 的情况下声称 dev outbox 已工作。

---

## 6. Embedded Collector 契约

### 6.1 Package 与启动方式

```text
packages/session-collector/
  src/runner.ts
  src/outbox.ts
  src/ingest.ts
  src/projector.ts
  src/claims.ts
  src/health.ts
```

API `server.ts` 启动 HTTP server 与 collector runtime，但两者生命周期和健康状态分开：

```text
EVELAND_COLLECTOR_MODE=embedded | disabled
```

Collector 循环的顶层必须 catch/backoff，不能产生 unhandled rejection 使公开控制 API 退出。

### 6.2 At-least-once

Collector 以 at-least-once 为基础：

- claim 文件；
- transaction 内 upsert Session/Node、insert Event、project usage/status；
- commit 后删除；
- commit 后删除前 crash 会重放，由 unique keys 消除重复。

必须限制：

- 单文件最大尺寸；
- 单 batch 事件数/字节数；
- 单轮处理时间；
- 并发 Session 数；
- backlog 总字节与最老事件年龄。

### 6.3 Discovery 与 parent linking

任意合法 envelope 都能隐式发现 Session，不要求第一条一定是 `session.started`：

1. `deploymentId` -> Project；
2. upsert `SessionNode(projectId, eveSessionId)`；
3. root node 没有 parent，创建/连接 root Session；
4. child node 有 parent Eve ID，upsert parent placeholder 并链接；
5. child 比 parent 先到达也必须最终一致；
6. `session.started.data.runtime` 更新 agentId/name/model/eveVersion；
7. `session.started.data.invocation` / `subagent.called` 补充 parent/call relationship；
8. remote subagent 暂时记录 remote URL 和 unresolved mapping，不直接抓取任意外部 URL。

### 6.4 Provenance merge

Gateway 与 Observer 各自掌握不同信息：

```text
Gateway:
  playground/api
  routeId
  experiment/variant
  deployment choice
  request ID / remote IP / affinity source

Observer:
  channelKind
  root/subagent identity
  parent session
  runtime model/version
  actual events/usage
```

按 `(projectId, eveSessionId)` 幂等合并。更具体的 provenance 不得被后到的模糊值覆盖。例如 Gateway 明确写入 `playground` 后，Observer 的 `channelKind=http` 不能把 trigger 改回 generic API。

建议映射：

```text
Gateway internal playground -> playground
Gateway canonical Eve HTTP   -> api
Observer schedule            -> cron
Observer channel:<name>      -> channel
Observer custom route        -> webhook/channel（按实际 kind）
Observer http without Gateway provenance -> direct_http
Observer subagent            -> child node，不创建新的 root trigger
```

### 6.5 Session state machine

不要复用当前 Playground 的 terminal set。权威边界：

```text
session.started / turn.started -> running
input.requested                -> waiting_approval
session.waiting                -> waiting（若仍有未解决 input，则 waiting_approval）
session.completed              -> completed
session.failed                 -> failed
```

`turn.completed` 只表示一轮结束，不表示 durable Session completed。新的 turn 可以在数小时/数天后继续同一个 Eve Session。

### 6.6 Usage projection

继续使用 Eve `step.completed.data.usage` 的 provider-reported 值：

- input tokens
- output tokens
- cache read/write tokens
- optional cost
- usage completeness

按 SessionNode 保存 step usage，root Session 汇总所有 local child nodes。Unique key 至少包含 `(sessionNodeId, turnId, stepIndex)`。Remote child 只有在映射到受管 Deployment 后才纳入精确 aggregate；否则记录 coverage gap。

### 6.7 Collector health

API liveness 与 Collector health 分开：

```text
GET /health
  control API liveness

GET /internal/collector/health
  status: healthy | delayed | degraded
  lastProcessedAt
  backlogEvents
  backlogBytes
  oldestEventAge
  quarantinedEvents
  lastError
```

Collector degraded 不应让 `/health` 失败，否则 proxy/systemd 会反复重启仍然可服务的控制 API。Web Overview 应显示 collector degraded。

### 6.8 何时拆成独立进程

出现以下任一条件再增加 `apps/collector`：

- API 多副本；
- collector backlog 影响 API latency/memory；
- Agent 分布到多台机器；
- 需要独立发布或扩容；
- 大量 stream reconciliation；
- API 与 collector 需要不同权限/SLO。

---

## 7. 数据模型不变量

实际表名可以调整，但必须满足以下语义。

### 7.1 Routing

```text
projects
  + routingKey unique, immutable, DNS-safe

agent_routes
  id
  projectId
  hostname unique
  kind: project | deployment | alias
  enabled
  policyRevision

route_targets
  routeId
  deploymentId
  weight 0..10000
  variantName nullable
  unique(routeId, deploymentId)
```

一个 route 的 active target 最多两个，权重总和必须为 10000。Deployment preview route 恰好一个 10000 target。

### 7.2 Session tree

```text
sessions
  id
  projectId
  rootNodeId
  trigger
  routeId nullable
  experimentId/variant nullable
  status
  aggregate usage
  startedAt/completedAt

session_nodes
  id
  rootSessionId
  projectId
  eveSessionId
  parentNodeId nullable
  parentEveSessionId nullable
  startedDeploymentId
  lastObservedDeploymentId
  agentId/name/nodeId
  channelKind
  modelId/eveVersion
  status
  unique(projectId, eveSessionId)

session_events
  sessionNodeId
  observerEventId
  eventFingerprint
  observedDeploymentId
  sourceSequence
  type
  payload
  eventAt
  unique(sessionNodeId, observerEventId)

session_bindings
  projectId
  eveSessionId
  routeId
  deploymentId
  experiment/variant
  affinity fingerprint（不要保存原始敏感 affinity key）
  unique(projectId, eveSessionId)
```

如果迁移过程中暂时保留现有 `sessions.eveSessionId` / `session_events.sessionId`，必须提供清晰 backfill 和兼容层；不要双写两套模型却没有权威来源。

### 7.3 Deployment semantics

现有 `deployments` 同时表达逻辑 Deployment 和运行进程。当前不考虑 replicas，因此可以暂时继续使用一张表，但以下字段语义要明确：

- release/config identity 创建后不可变；
- hostPort/processName/status 是 runtime state，可因 restart/cold-start 更新；
- 一个 Project 可以同时有多个 running Deployment；
- `projects.currentDeploymentId` 只是过渡兼容字段，最终 production project route 才是权威；
- build+deploy 不再默认停止旧 Deployment；新 Deployment 首先是 preview target；
- promote/rollback/traffic split 通过 route target transaction 完成。

---

## 8. 实现顺序（必须分阶段，不做一个巨型 PR）

### Phase 1 — Package boundaries，零行为变化

目标：先清理依赖方向，为后续并行演进建立稳定边界。

#### Files / moves

- 创建 `packages/core`；
- 将 `packages/shared` 内容迁入 `core` explicit subpaths；
- 将 `apps/api/src/types.ts` 的跨 App domain/contracts 迁入 `core/contracts`；
- 将 Eve request/event/usage parsing 迁入 `core/eve`；
- 创建 `packages/db`，迁移 Drizzle schema、migrations、mappers、Postgres Store 和 memory Store；
- 更新 Drizzle scripts/config；
- worker 改为依赖 `@eveland/db` / `@eveland/core`，移除 `@eveland/api` 依赖；
- 更新所有 tests/imports；
- 删除无用 exports，不保留 App -> App compatibility shim。

#### Constraints

- API routes、worker behavior、DB schema 在本 phase 不变；
- 不创建 Gateway；
- 不创建 observer/collector；
- 不顺便重写 UI；
- 保持所有已有 tests 绿色。

#### Acceptance

- `rg '@eveland/api' apps/worker packages` 无结果；
- `core` 不依赖 `db`；
- Web 只从 browser-safe core subpaths import；
- `pnpm test`、`pnpm typecheck`、`pnpm build` 通过。

### Phase 2 — Observer + outbox + embedded collector vertical slice

目标：先解决原始问题——即使绕过 Playground/未来 Gateway，受管 Agent 的 Session 仍会进入平台。

#### Tasks

1. 完成 subagent coverage investigation 和 fixture tests；
2. 创建 `packages/agent-observer` generator/injector；
3. 创建 common prepared-release step，让 Docker/systemd 都从注入后的 release tree 构建，绝不修改 source repo；
4. systemd/Docker 注入 outbox path 和权限/mount；
5. 创建 ObserverEnvelope V1 schema；
6. 创建 `packages/session-collector`；
7. API embedded 启动 collector；
8. 增加 Session/SessionNode/Event/Usage migration；
9. 移除 Playground route 内的同步 usage collector，Playground transport 与 collector 分离；
10. 更新 Session UI 以读取新 root/node aggregate（保持视觉改动最小）。

#### Required proof

- 直接请求受管 Agent private port 创建 Session，不经过 `/playground`，DB 中仍出现 root Session、events 和 usage；
- root Agent 调用 directory-form subagent，DB 中形成 parent/child tree，usage 正确聚合；
- Collector 停止期间事件落盘，恢复后补齐；
- Collector 在 DB commit 后、删除 outbox 前 crash，重放不会重复累计 usage；
- invalid envelope 被 quarantine，不阻断其他事件；
- Observer outbox 写失败不会使 Eve turn 失败；
- systemd VM smoke 和 Docker dev smoke 都有真实证据。

### Phase 3 — Gateway baseline + stable/preview host routing

目标：公开 Agent 入口只经过 Gateway；先实现单 target，不做 A/B。

#### Tasks

1. 创建 `apps/gateway` Hono/Node app；
2. Project `routingKey` migration + backfill；
3. `agent_routes` / one-target `route_targets`；
4. stable project host 与 immutable deployment preview host；
5. Host validation/cache/invalidation；
6. transparent streaming proxy；
7. auth/Host spoofing regression tests；
8. Gateway discovery 写 SessionBinding/provenance；
9. Playground transport 最终改走 internal Gateway path；
10. Traefik production example、Compose、README、Linux deploy docs；
11. UI 显示 stable endpoint 与 preview endpoint，不显示 raw port。

#### Required proof

- `p-xxx.agent.localhost:4080` 正确路由 current project target；
- `d-xxx--p-xxx.agent.localhost:4080` 固定路由指定 Deployment；
- unknown/disabled/no-running-target 的状态码符合契约；
- `Authorization` / Cookie / canonical Host 透传；
- production Host 不会触发 Eve localDev；
- NDJSON 首个 chunk 不等待完整 Session 结束即可到达 client；
- `/.well-known/workflow/v1/flow` 正确转发；
- public Agent port 未直接暴露。

### Phase 4 — Concurrent Deployments、Alias、A/B、drain/retention

目标：完成 Vercel-style preview/promote/rollback 和 Cloudflare-style session-affine traffic split。

#### Tasks

1. worker build/deploy 不再停止 current Deployment，不再复用 running Deployment port；
2. 支持一个 Project 多个 running Deployment；
3. named aliases 和最多两个 weighted targets；
4. deterministic affinity；
5. initial SessionBinding 与 continuation/stream pinning；
6. atomic promote/rollback/weight update + Gateway cache invalidation；
7. Deployment state：running/draining/stopped/archived；
8. 保留最近 3 个 artifact 的 GC policy；
9. active SessionBinding protection / drain policy；
10. Collector 按 deployment/experiment/variant 聚合 metrics；
11. Web Deployment 页面：preview、promote、rollback、traffic split、draining、retention。

#### Required proof

- A=90/B=10 时，新 Session 按 deterministic bucket 分配；
- 权重从 90/10 改成 50/50 后，已有 Session continuation/stream 仍回原 Deployment；
- preview URL 永远固定一个 Deployment，不受 production route 变化影响；
- promote/rollback 不改 DNS、不重启 Gateway；
- B 降为 0 后不再接收新 Session，但已有非终态 binding 能继续；
- protected Deployment 不会被 GC；
- variant metrics 能比较 success/failure/latency/token/cost。

---

## 9. 测试矩阵

### Unit

- DNS-safe routingKey 生成、backfill、collision retry；
- Host parser 与 base-domain validation；
- header strip/rebuild；
- weight validation 与 deterministic bucket；
- ObserverEnvelope schema；
- canonical event fingerprint；
- outbox filename/path containment；
- Session state projector；
- usage idempotency；
- provenance precedence；
- retention/protection predicate。

### API/DB integration

- Gateway/Observer discovery race；
- child-before-parent arrival；
- at-least-once replay；
- transaction rollback leaves outbox recoverable；
- duplicate usage step does not increment aggregate；
- SessionBinding lookup；
- promote/rollback transaction；
- route target weight constraints。

### Gateway integration

- fake upstream echoes Host/Auth/Cookie；
- request streaming 与 NDJSON response streaming；
- large body limit；
- aborted client cancels upstream；
- unknown host / spoofed forwarding headers；
- local-dev vs production auth behavior；
- workflow callback route；
- custom channel path passthrough。

### Real Eve fixtures

- root session；
- continuation after `session.waiting`；
- HITL `input.requested`；
- local directory subagent；
- file-form subagent coverage investigation；
- remote subagent unresolved behavior；
- provider-reported and missing usage；
- direct private-port request；
- Gateway request。

### Runtime smoke

- Docker dev；
- systemd Lima VM；
- collector downtime/recovery；
- deployment restart；
- two concurrent Deployments for one Project；
- promote/rollback；
- A/B Session pinning。

---

## 10. Operational/security constraints

- Gateway 不挂 Docker socket，不读取 source tree，不解密 Project Secrets；
- API/Collector 不拥有 systemd/root 权限；
- Worker 保持不公开，继续是唯一 root/systemd controller；
- Observer outbox directory 只授权单 Deployment；
- 外部调用者不能通过 `X-Eveland-*` 影响 route、deployment、trace parent 或 affinity override；
- 不记录原始 API key/affinity key，只记录 hash/fingerprint；
- 不在 logs、events、outbox filenames 中暴露 Secret；
- raw reasoning 默认不采集；
- collector backlog/disk usage 必须可见并报警；
- public Gateway 与 internal privileged Gateway path 必须有明确网络或 service credential 隔离；
- CORS 仍是 Agent 应用策略，Gateway 透明转发，不擅自放宽为 `*`。

---

## 11. Non-goals

本轮明确不做：

- Deployment replicas / load balancing replicas；
- multi-region；
- Kubernetes；
- Kafka/NATS/Redis stream；
- 自动 custom-domain certificate/CNAME 管理；
- 任意外部 remote Agent 的直接 stream 抓取；
- Gateway 替 Agent 实现用户认证；
- 在线代码编辑；
- 保存完整 reasoning delta；
- 在一个 PR 中完成全部 phase。

---

## 12. 文档同步要求

每个 phase 完成时同步更新：

- `docs/spec.md`：产品行为与核心对象；
- `README.md`：开发启动方式、Gateway URL、collector mode；
- `docs/deploy/linux.md`：端口、Traefik、outbox、permissions、retention；
- Compose/env examples；
- 若新增运维限制，加入 Known limits；
- 若 runtime behavior 与本文件不同，更新本文件并在 PR 中解释，不要让 handoff 静默过时。

---

## 13. 每个 Phase 的统一 Verification

至少运行：

```bash
pnpm test
pnpm typecheck
pnpm build
```

并运行 touched package 的 focused tests。涉及 Compose 时验证 merged config；涉及 systemd/Docker/observer 时必须运行相应真实 smoke，不得只靠 mocked unit tests。

提交前：

```bash
git status --short
git diff --check
```

保持无关 worktree 变化不进入本任务。

---

## 14. 从哪里开始

第一步只实施 **Phase 1 — Package boundaries**。

不要先创建 Traefik 配置，也不要先创建空的 Gateway/Collector scaffold。Phase 1 的完成标准是：

```text
apps/worker 不再依赖 apps/api
core/db 边界落地
现有行为与测试不变
```

随后 Phase 2 做一个真实 vertical slice：

```text
受管 Eve Agent 直接通过 private port 运行
  -> injected Hook 写 outbox
  -> embedded Collector 入库
  -> Web Sessions 可见 root/subagent usage
```

只有这条链路通过真实 Docker + systemd smoke 后，才进入 Gateway。这样每个阶段都有独立价值，也避免同时调试 package move、Eve hook、filesystem permissions、proxy auth 和 A/B routing。

---

## 15. 2026-07-14 follow-up：本地 Docker exec sandbox

完成 Phase 后发现一处 runtime parity 缺口：systemd Release 会注入
`@eveland/sandbox-bwrap`，而本地 Docker Release 只注入 observer，导致生产式
`eve start` 落到缺少 optional peer 的 `just-bash`，内置 file/bash tools 在第一次
调用时失败。后续实现将 sandbox injection 移到两个 runtime 都会执行的 Release
准备路径，并保留以下边界：

- Agent container 永远不挂 Docker socket；
- local Docker image 安装 `bash`/`bubblewrap` 并预建 `/workspace`；
- outer container 先 drop 全部默认 capability，只为 nested bwrap 增加
  `SYS_ADMIN` 与 `NET_ADMIN`，同时设置 `no-new-privileges`；该放宽只属于本地
  Docker runtime，production 继续使用 unprivileged systemd+bwrap；
- sandbox cache 使用 `EVELAND_HOST_DATA_DIR` 映射并按 Project 持久化，redeploy
  不丢 durable Eve Session 的 workspace；
- Docker 与 systemd build self-check 都必须在真实 bwrap 中写入并用 Node 24
  执行带类型标注的 `.ts` probe，不能用 `/eve/v1/health` 代替。
