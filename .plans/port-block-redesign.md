# 端口重设计：搬块（Phase 1）+ 单前门 origin 合并（Phase 2）

状态：待实施。本文档自包含，不依赖其他上下文。两个 Phase 各自独立成 PR：Phase 1 先行、
独立可发布；Phase 2 依赖 Phase 1 的常量模块，可间隔实施。

**终态**：整机对外只有一个非回环监听端口（17300，前门）。Dashboard、API、公开 agent 流量
全部经它进入；PG、otel、web、API、agent 实例全部只绑 127.0.0.1。

## 背景与动机

平台当前使用通用默认端口（3000/3001/4000/4080/5432/4318），在开发者机器上高概率冲突。
历史事故直接相关：#167 端口冲突事故；Lima VM 抢占 127.0.0.1:5432 导致容器静默连上冒烟
测试库（症状为 Playground "Failed to create the session." + "no partition of relation
workflow_events"）。通用端口的风险不只是启动失败，更危险的是**静默连错服务**。

多 origin 的额外代价：浏览器要和 Dashboard、API 两个 origin 打交道，产生 CORS、跨 origin
cookie、`BETTER_AUTH_URL` 必须配成浏览器可见 API origin（自架用户最常见翻车点，"login is
per-port"）、`NEXT_PUBLIC_API_URL` 构建期烘焙、服务器部署要开多个防火墙口/配多个反代。

时机约束：即将面向 curl-install 的陌生受众开源推广。默认端口一旦有外部用户依赖就成为
兼容性契约。Phase 1 必须在 CLI/installer 工程之前完成，也应在 Model Gateway 分支合并之前
定案（见"协调事项"）。

---

# Phase 1：搬块

## 目标与非目标

**目标**：把平台全部固定监听端口迁入一个独享的连续端口块；agent 动态端口段迁出 Linux
临时端口区；端口默认值单一来源化 + ratchet 防回潮。

**非目标**（Phase 1 明确排除）：

- Origin 合并——即 Phase 2，见下。Phase 1 仅为它预留 base+0 前门位。
- **`EVELAND_INTERNAL_PORT ?? 3000`**（apps/worker/src/runtime/select.ts:61）——这是
  agent 沙箱**内部**的监听口，独立网络命名空间无冲突，属沙箱契约，不动。PR 中显式注释排除。
- CI service container 的 `5432:5432` 映射（.github/workflows/ci.yml）与测试夹具里的显式
  测试 URL——GitHub Actions 的隔离环境无冲突问题，保留不动，降低改动面。
- 冲突时的自动平移/整块 offset 机制（`EVELAND_PORT_BASE` 单变量推导）——CLI 工程的事，
  本次只要求"常量单一来源"，为将来推导留结构即可。

## 新端口方案（提案，基址数字可在实施时最终拍板）

选址原则：>10000 避开常用开发端口；<32768 避开 Linux 默认临时端口区（32768–60999，
监听绑定会与出站源端口瞬时相撞）；避开区间内知名住户（27017 mongo、17500 Dropbox
LanSync 等）。实施第一步是对最终选定区段做一次 IANA + 常见开发工具的核对。

固定块 **17300–17399**，agent 动态段 **18000–18999**（刻意不连续，跳过 17500 Dropbox）：

| 新端口  | 旧端口  | 用途                                                                                        | 当前默认值定义点                                                    |
| ------- | ------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 17300   | 3000    | Dashboard（Phase 2 起改由 gateway 占据，成为唯一前门；用户书签 `:17300` 跨 Phase 语义连续） | `WEB_ORIGIN` 回退散布多处（见清单）                                 |
| 17301   | 4000    | API                                                                                         | apps/api/src/server.ts `PORT ?? 4000`                               |
| 17302   | 4080    | Agent Gateway（bind；Phase 2 起让位给 web 的内部口）                                        | apps/gateway/src/server.ts `GATEWAY_PORT ?? 4080`                   |
| 17303   | 4090    | Model Gateway（**预留**，分支未合并）                                                       | 分支上 `MODEL_GATEWAY_PORT ?? 4090`                                 |
| 17310   | 5432    | PostgreSQL（仅 127.0.0.1 绑定）                                                             | compose 映射 + 各 DATABASE_URL                                      |
| 17311   | 4317    | otel collector gRPC                                                                         | compose                                                             |
| 17312   | 4318    | otel collector HTTP                                                                         | `EVELAND_OTLP_ENDPOINT` 默认值                                      |
| 17350   | 3001    | 文档站（仅 dev，不进前门）                                                                  | apps/docs package.json                                              |
| 18000起 | 41000起 | agent 部署动态段（仅回环）                                                                  | apps/worker/src/runtime/ports.ts `EVELAND_DEPLOYMENT_PORT ?? 41000` |

注意：`EVELAND_GATEWAY_PUBLIC_PORT`（对外通告端口，区别于 bind 端口 `GATEWAY_PORT`）
语义不变，默认值随 bind 口同步改为 17302；prod compose 中为 0（跟随 scheme）的语义保留。
这条 advertised-vs-bind 双轨正是 Phase 2 的现成钩子。

## 实施结构：单一来源 + ratchet

1. **在 packages/core 新建端口常量模块**（如 `packages/core/src/ports.ts`）：全部默认端口
   与默认 origin 字符串从这里导出。注意 PG 有**三种地址形态**必须同源推导：
   `localhost:17310`（宿主进程视角）、`host.docker.internal:17310`（容器视角）、
   `postgres:5432`（compose 服务名——容器网络内部端口**可保留 5432**，只改宿主映射
   `127.0.0.1:17310:5432`，减少容器侧改动；实施时二选一并全局一致）。
2. **packages/core/src/config-diagnostics.ts 改为引用该模块**——它已是中央 env 注册表，
   但各消费点又各自重复了字面量，本次一并收敛。
3. **消费点清扫**（普查所得，逐一改为引用常量模块）：
   - apps/api/src/server.ts、app.ts、auth-config.ts、app-identity-routes.ts、app-support.ts
   - apps/gateway/src/server.ts（`GATEWAY_PORT`、`EVELAND_API_INTERNAL_URL ?? 127.0.0.1:4000`）
   - apps/web/next.config.ts、src/lib/api-transport.ts、src/lib/server-api.ts
   - apps/worker/src/runtime/ports.ts（动态段基址）、identity-config-reconciler.ts、
     jobs/collector-observability/control.ts（两处 127.0.0.1:4000 内部 endpoint）
   - packages/db/drizzle.config.ts（DATABASE_URL 回退）
4. **配置与基础设施文件**：
   - `.env.example`（含 workflow-world 双 URL 的两种地址形态）
   - `docker-compose.yml`、`docker-compose.prod.yml`
   - `infra/systemd/*.env.example`（worker、workflow-dispatcher 等多处 5432/4000）
   - `infra/integration/run.sh`、`identity-e2e.mts`（硬编码 WEB_ORIGIN:3000 / CHAT_ORIGIN:3010）、
     `systemd-smoke.ts`（其注释声称固定端口"well outside EVELAND_DEPLOYMENT_PORT 默认分配段"，
     动态段搬家后需重新核对该假设）
   - `.github/workflows/systemd-smoke.yml`（workflow-world URL）
5. **文档**：双语 `docs/*/reference/environment-variables.md` 等，普查为 4 个文件约 10 处。
   注意 docs 是单一来源、CI 有 doc-binding 路径检查。**spec.md 不含端口字面量，不要碰**
   （有版本字面量守卫测试的先例，端口同理留在 reference 层）。
6. **3010 特案**：`EVELAND_IDENTITY_ALLOWED_ORIGINS` 默认值 `http://localhost:3010` 指向
   一个假想的第三方 chat 应用 origin，并非平台监听口，却在
   apps/api/src/app-identity-routes.ts:57、config-diagnostics、compose、.env.example、双语
   文档五处享受代码级默认值待遇。**决策：移除代码级默认（默认空数组），示例仅存于
   .env.example 注释与文档**。identity-e2e.mts 的 CHAT_ORIGIN 改为显式传参。
7. **动态段搬迁**（41000 → 18000）：41000 位于 Linux 临时端口区内，是瞬时冲突源。搬迁时
   在 ports.ts 加注释说明选址理由（临时区规避）。核对与 readiness 端口所有权门
   （PR #168 引入的 verifyPortOwnership，systemd-only）的交互——只是基址平移，预期无逻辑
   变化，但冒烟测试必须过。
8. **Ratchet**：在 packages/architecture-tests 加一条——除端口常量模块（及测试文件、
   drizzle 迁移快照）外，产品代码禁止出现 `3000|3001|4000|4080|4090|5432|4317|4318|41000`
   及新端口的裸字面量。防止回潮 + 防止新代码绕过单一来源。

## Phase 1 已知陷阱（普查与历史事故所得）

- **NEXT_PUBLIC_API_URL 是构建期烘焙进 web bundle 的**：改端口后必须重建 apps/web 才生效。
  本地验证时注意清理 `.next/`（有"stale dist 两次掩盖 break"的先例——本地验证必须含
  clean build，镜像 CI 的干净起点）。
- **PG 三形态**见上；查找替换必漏，务必从常量模块推导。
- **端口字面量可能藏在 .tsx 里**（eve 升级时"版本字面量藏在 .tsx"的同类前科），ratchet
  测试是兜底，但清扫时对 apps/web 全量 grep 一次。
- **Lima 冒烟基建当前用 55432**（也在临时端口区内），顺手评估是否一并迁入新块附近的
  测试专用段；OrbStack 曾出现 55432 端口转发静默失效。
- 本次是 **breaking change**（0.x minor 惯例允许）：CHANGELOG 明确记录 +
  `docs/*/operations/upgrades.md` 写迁移指引（自架用户需更新自己的 .env / 反代 / 防火墙）。
  commit message 遵循 conventional commits 且 **scope 括号不能为空**（空括号会被
  release-please 从 changelog 静默丢弃）。

---

# Phase 2：单前门（origin 合并）

## 终态设计

**前门归属 Agent Gateway。** 理由：它已是公共边缘（公开 agent 流量、Playground 流都经它）、
已持有 `EVELAND_API_INTERNAL_URL` 指向 API 的内部转发配置、SSE/流式处理最成熟、且
advertised-vs-bind 双轨（`EVELAND_GATEWAY_PUBLIC_PORT` / `GATEWAY_PORT`）现成。不新增
第七个进程，不用 Next.js rewrite 承载 agent 流量。

**端口调换**（常量模块两行改动，得益于 Phase 1 单一来源）：gateway bind 17302 → 17300，
web 17300 → 17302 且改绑 127.0.0.1。用户书签 `http://host:17300` 在两个 Phase 里始终是
"Dashboard 的地址"，语义连续。

**路由表**（17300 上按前缀分发）：

| 前缀                                | 去向                   | 说明                                            |
| ----------------------------------- | ---------------------- | ----------------------------------------------- |
| `/api/*`                            | API（127.0.0.1:17301） | 见"strip vs base path"决策点                    |
| `/.well-known/*`                    | API                    | OIDC discovery / JWKS 必须在 issuer origin 根部 |
| agent 公开路径（现有 gateway 路由） | 各 agent 实例          | 不变                                            |
| `/internal/*`                       | **不路由**             | 见下——顺手的安全增益                            |
| 其余 `/*`                           | web（127.0.0.1:17302） | Dashboard 兜底                                  |

**安全增益（明确写进 PR 描述）**：`/internal/*`（scheduler dispatch、内部 otel 投递、
observability destinations 等）今天暴露在公开的 API 端口上、靠鉴权防护；Phase 2 后它们
只在回环可达（worker/dispatcher 本来就走 127.0.0.1 内部 URL），公网攻击面实质缩小。

**配置坍缩清单**（Phase 2 的红利，逐项落实并从文档删除）：

- `NEXT_PUBLIC_API_URL` → 前端改用相对路径 `/api`，构建期烘焙问题整个消失。
- `WEB_ORIGIN`、`BETTER_AUTH_URL`、`EVELAND_IDENTITY_ISSUER` 收敛为同一个前门 origin
  （可考虑合并成单一 `EVELAND_PUBLIC_ORIGIN`，其余派生）。
- API 侧 CORS 配置大幅删除（同 origin 后浏览器不再发跨 origin 请求）。
- headless/自架文档简化：开一个防火墙口、配一个反代/TLS 即可。

## Phase 2 陷阱与风险

- **better-auth base path**：`BETTER_AUTH_URL` 从 origin 根变为带 `/api` 前缀（或经
  strip 后 API 仍以根路径视角运行）。核验 better-auth 对 basePath 的支持方式；注意与
  **未合并的 better-auth 1.7 升级**（已评估：account.issuer 迁移那单）排好先后，避免
  两个改 auth 配置的 PR 交叉。
- **OIDC issuer 变更是存量数据迁移，不只是配置改动**：`EVELAND_IDENTITY_ISSUER` 从 API
  origin 变为前门 origin。已有部署的 identity 配置要过 worker 的
  identity-config-reconciler；有"rotation 删除 transactions"的前科，issuer 变更路径要
  单独测试（identity-e2e 覆盖 open + internal 两条流）。新装走新默认、存量升级要写
  明确迁移步骤进 upgrades.md。
- **Dashboard API 流量新增一跳（经 gateway）**：注意 gateway 的流式与超时行为——
  现网约定 stream heartbeat ≤5s（对抗 eve client 15s read-idle timeout），另有 gateway
  unbounded tee 的历史备忘。Playground 长流、SSE 心跳在新拓扑下必须专项回归。
- **strip vs base path 二选一并全局一致**：gateway strip `/api` 前缀（API 代码零改动，
  但 API 自己生成的绝对 URL——如 auth 回调、JWKS 引用——要正确外显）vs API 原生挂
  base path（改动大但无 URL 重写魔法）。实施时定夺，倾向前者 + 显式的
  `EVELAND_PUBLIC_ORIGIN` 供 API 生成外部 URL。
- **保留前缀 vs agent slug 碰撞**：`/api`、`/.well-known`、`/_next`、`/internal` 等成为
  保留字。核对现有 agent 公开路径方案是否已有命名空间前缀；若 slug 可与保留字撞车，
  在 import/命名校验处加保留字黑名单。
- **dev 模式同拓扑**：建议 `pnpm dev` 也走 gateway 前门（gateway 代理 next dev），消灭
  dev/prod 两套 origin 心智；需验证 HMR websocket 经代理正常。若验证成本过高，dev 保持
  直连但必须在文档里显式承认差异。
- 本 Phase 也是 breaking change：自架用户的反代配置从两条 upstream 变一条；upgrades.md
  给出前后对照。

## Phase 2 验证清单

1. 登录/登出、会话 cookie 在单 origin 下全流程（含首次安装种子 admin 流）。
2. identity-e2e（open + internal）在新 issuer 下通过；存量 issuer 迁移路径单独演练。
3. Playground 长对话流 + 心跳（≥15 分钟空闲流不断）；`curl` 公开 agent URL。
4. `/internal/*` 从公网不可达、从回环可达（scheduler dispatch 实测触发一次 schedule）。
5. Lima systemd 全梯队 + docker/prod compose 冒烟；clean build。

---

# 配置面缩减（.env 瘦身）

`.env.example` 现有 **79 个真实条目**，按性质分三类，命运各异。量化目标：**必填 .env
收敛到 ≤10 条**（installer 向导要问的问题数 = 必填条目数，这是 CLI 工程的直接乘法）。

**1. 拓扑/地址类（约 15 条）→ 随 Phase 2 消灭。** `BETTER_AUTH_URL`、`WEB_ORIGIN`、
`NEXT_PUBLIC_API_URL`、`API_URL`、`EVELAND_IDENTITY_ISSUER`、`EVELAND_IDENTITY_JWKS_URL`、
`EVELAND_GATEWAY_INTERNAL_URL`、`EVELAND_API_INTERNAL_URL`、`EVELAND_OTLP_ENDPOINT`、
`EVELAND_SCHEDULER_REDEEM_URL`、`WORKFLOW_DISPATCHER_ACTIVATION_API_URL`、
`EVELAND_GATEWAY_PUBLIC_SCHEME/PORT` 全是同一拓扑的不同投影：坍缩为单一
`EVELAND_PUBLIC_ORIGIN`，内部回环 URL 变为端口常量模块的代码默认值、**彻底移出 .env**
（仅保留覆盖能力）。三条 PG URL（`DATABASE_URL` + workflow-world 两条）收敛为一个 PG
位置推导。此项并入 Phase 2 的"配置坍缩清单"。

**2. 秘密类（9 条）→ 归 CLI/installer 工程：全部生成，用户零手填。** 其中 7 条是纯内部
服务间令牌（gateway service token、affinity secret、scheduler 两个 secret、dispatcher
activation token、OTLP service token 等），installer 首次安装随机生成写入；用户只参与
`EVELAND_ADMIN_PASSWORD`（onboarding 问一次）。背景教训：`APP_SECRET_KEY` 的 prod
fallback 曾是审查确认的"修了实例没修类"头号发现——"secrets 全部生成、绝无默认值"
把这类问题连根拔掉。

**3. 调参类（约 45 条）→ 独立小 PR，零行为变化。** 各种 `*_MS`/batch size/sandbox 限额/
retention 在代码里已有默认值（config-diagnostics 注册表），双语 environment-variables
reference 已是正式文档。把它们从 `.env.example` 整体删除（文件里留一行指向 reference
文档），新用户打开不再面对 79 行噪音。可在 Phase 1 之后任意时点做。

**终态 `.env`（installer 生成）**：`EVELAND_PUBLIC_ORIGIN`、`EVELAND_DATA_DIR`（绝对
路径）、`DATABASE_URL`、`EVELAND_ADMIN_EMAIL/PASSWORD` + 自动生成的 secrets 块
（注释标明"自动生成，勿手填"）。

**注意事项**：

- CI 有 env-coverage ratchet（env 变量与文档绑定检查）：删条目时同步调整，方向是让它
  转而强制"必填集最小化"，不是削弱它。
- .env 热加载陷阱：.env 改动需重启进程、存量部署容器保留旧 env 直到冷启动。upgrades.md
  写明：存量 .env 中变冗余的条目可删，删后需重启。

---

## 协调事项

- **Model Gateway 分支**（claude/model-gateway-unified-api-53a545，未合并）：4090 足迹约
  8 个文件（server.ts 默认值、.env.example 两种地址形态、双 compose 的
  `127.0.0.1:4090:4090` 发布、config-diagnostics 白名单、双语 env 文档表、集成 run.sh）。
  Phase 1 先合并、预留 17303；该分支 rebase 时改用常量模块并 remap 到 17303。
  Model Gateway 数据面是纯内部服务（回环绑定），不进前门路由。
- **better-auth 1.7 升级**（已评估未实施）：与 Phase 2 都动 auth 配置，排好先后、勿交叉。
- **下游**：CLI/installer 工程（另行规划）将以本方案为端口事实来源；installer 的
  "问用户访问域名"步骤在 Phase 2 后只需产出一个 `EVELAND_PUBLIC_ORIGIN`。

## Phase 1 验证清单

1. 单元 + 集成测试全绿（预期少量测试需跟随常量模块调整）。
2. 本地 `pnpm dev` 六进程在新端口全部起动，Dashboard 登录、Playground 会话、import→build
   →deploy→promote 全链路手工过一遍。
3. `docker compose up`（dev）与 prod compose 冒烟。
4. Lima systemd 全梯队冒烟绿（历史上多个 break 仅被 Lima 捕获；harness 网络不稳，失败先
   重试再诊断）。
5. clean checkout 全量 build（镜像 CI 的 job 清单与干净起点）。

## 留给实施时拍板的点

Phase 1：

1. 基址最终数字（17300 为提案；改动成本仅在常量模块一处）。
2. compose 内部网络是否保留 `postgres:5432` 服务名端口（推荐保留，只改宿主映射）。
3. Lima/测试基建端口是否本次一并迁移（推荐：是，工作量小且顺手消灭 55432 临时区问题）。

Phase 2：

4. `/api` 前缀 strip vs API 原生 base path（倾向 strip + `EVELAND_PUBLIC_ORIGIN`）。
5. dev 模式是否同拓扑走 gateway 前门（倾向是，取决于 HMR 代理验证）。
6. `WEB_ORIGIN`/`BETTER_AUTH_URL`/`EVELAND_IDENTITY_ISSUER` 是否合并为单一
   `EVELAND_PUBLIC_ORIGIN`（倾向是）。
7. 存量部署的 issuer 迁移策略（自动 reconcile vs 文档化手工步骤）。
