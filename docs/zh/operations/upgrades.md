---
title: 升级与回滚
description: 在明确 Migration、组件 Identity 与 Runtime Ownership 的前提下升级精确 Eveland Release。
---

将 Eveland Upgrade 视为协调一致的产品变更，而不是五个可部署组件（Dashboard、API、Agent Gateway、Worker 与 Workflow Dispatcher）各自重启。

各版本的专属升级步骤与兼容性说明见 [GitHub Release Note](https://github.com/evelandhq/eveland/releases)。开始前请阅读当前版本到目标版本之间每个 Release 的说明。

## 版本策略与 Release Channel

Eveland 使用 SemVer，从 `0.1.0` 开始：修复递增 Patch，特性递增 Minor，1.0 之前的破坏性变更同样递增 Minor 并附带明确的升级与回滚说明。Eveland 只支持最新的稳定 `0.x` Release；没有长期维护分支，也不向旧 Minor 回移修复。

每个组件报告同一份产品 Identity——`version`、`revision`、`channel` 与 `component`——出现在 Public `/health`（API、Agent Gateway）、启动日志与 **Settings → About** 中。`channel` 为 `dev`、`edge`、`prerelease` 或 `stable`：稳定安装运行精确的 `vX.Y.Z` Tag 并使用 `EVELAND_RELEASE_CHANNEL=stable`；测试 `main` 的实例使用 `edge` 和其精确 Revision。缺失值会有意变成 `unknown` 与 `dev`，而不是冒充稳定 Release。为每个组件设置相同的 `EVELAND_REVISION`（通常为 `git rev-parse --short=12 HEAD`）与 Channel。

GitHub Release 目前标识的是可复现的源码版本，而不是一组不可变容器镜像加 Worker 包：运维需要 Checkout Tag、安装 Frozen Lockfile、应用 Migration，并从同一 Revision 重启每个组件。不要把可变分支、`latest` 别名或部分重启的 Checkout 当作 Release 证据。

## 升级前

1. 阅读目标 GitHub Release Note 与兼容性变化。
2. 备份 Postgres、共享 Workflow 数据库与配置的数据根目录——见[备份与恢复](/zh/docs/operations/backup-restore)。
3. 确认每个组件报告当前精确 Revision。
4. 检查是否存在需要 Drain Deployment 的 Runtime Migration 或特别说明。

## 应用 Release

在核心服务 Checkout 中获取 Tag、Checkout 目标 Stable Tag、安装 Frozen Lockfile 并应用版本化的控制平面 Migration：

```bash
git fetch --tags origin
git checkout vX.Y.Z
pnpm install --frozen-lockfile
pnpm --filter @evelandhq/api db:migrate
```

对宿主机 Worker 自己的 Checkout（通常为 `/opt/eveland`）应用同一 Tag 与 Frozen Install。Worker 升级到此为止：Sandbox Backend（`@evelandhq/sandbox-bwrap`）由 Lockfile 固定、从 npm 预编译发布，没有单独的 Backend 构建步骤。共享 Workflow World 的 Schema Migration 也不是手动步骤——Worker 启动与 Tenant Provisioning 会自动应用所有待执行 Migration。

为五个组件设置相同的 Release Channel 与 Revision，再从该 Checkout 重启。只有 Public Health、Worker Startup Identity 与 **Settings → About** 全部一致后，升级才算完成。

## 回滚边界

只有旧版本仍兼容所有已应用 Migration 时，Checkout 旧 Tag 才安全。数据库 Migration 不会自动反向执行。必须遵循 Release 专属 Rollback Note，不能假设源码回滚已经足够。

不要通过切换 `EVELAND_RUNTIME` 规避升级步骤。已有 Deployment 保留其记录的 Runtime Owner；迁移宿主机 Runtime 前必须有意识地 Drain。

## 端口块迁移

Eveland 已将所有默认监听端口从通用开发端口迁入平台独享端口块；Deployment 动态端口段也迁出了 Linux 临时端口区。容器内部端口（Compose 服务 DNS，如 `postgres:5432`、`otel-collector:4318`）保持不变——只有宿主机可见端口发生迁移：

| 服务                                           | 旧默认值  | 新默认值    |
| ---------------------------------------------- | --------- | ----------- |
| Dashboard                                      | 3000      | 17300       |
| API（`PORT`）                                  | 4000      | 17301       |
| Agent Gateway（`GATEWAY_PORT`）                | 4080      | 17302       |
| Postgres 宿主机映射                            | 5432      | 17310       |
| Collector 平台 Receiver                        | 4317/4318 | 17311/17312 |
| Collector Agent Receiver                       | 4327/4328 | 17313/17314 |
| 文档站 dev server                              | 3001      | 17350       |
| Deployment 分配段（`EVELAND_DEPLOYMENT_PORT`） | 41000     | 18000       |

对存量安装：

1. 更新 `.env` 与 systemd env 文件中所有引用旧默认端口的 URL 与端口（`DATABASE_URL`、`EVELAND_WORKFLOW_WORLD_URL`、`BETTER_AUTH_URL`、`EVELAND_GATEWAY_INTERNAL_URL`、`EVELAND_API_INTERNAL_URL`、`EVELAND_OTLP_ENDPOINT`、`EVELAND_IDENTITY_JWKS_URL`、`EVELAND_SCHEDULER_REDEEM_URL`、`WEB_ORIGIN`、`NEXT_PUBLIC_API_URL`、`API_URL` 等）——对照最新的 `.env.example`。继续沿用旧端口也是允许的：迁移的只是默认值，显式配置始终优先。
2. 更新反向代理 upstream（Agent Gateway `4080` → `17302`）与宿主机防火墙规则（对非本地网络阻断 `17310` 而非 `5432`）。
3. `NEXT_PUBLIC_API_URL` 在构建时烘焙进 Dashboard：修改后必须重新构建 web 应用。
4. 重启所有组件——env 变更从不作用于运行中的进程，Compose 容器在重建前保留旧 env。
5. `EVELAND_IDENTITY_ALLOWED_ORIGINS` 不再有开发默认值（`http://localhost:3010`）：若外部 chat 前端依赖它，必须显式设置。

存量 Deployment 保留已记录的端口；新建与重启的 Deployment 实例从新端口段分配。

## 单一前门（Origin 合并）

继端口块迁移之后，Agent Gateway 成为唯一公开入口：它绑定 `17300`，在平台 Host 上服务 Dashboard、浏览器 API（`/api/eveland/*`，fail-closed Allowlist）、Better Auth（`/api/auth/*`）与 Identity Issuer 文档（`/.well-known/*`），在 Wildcard Agent Host 上服务 Agent 流量。API（`17301`）与 Dashboard（`17302`）退到其后仅绑回环；`/internal/*` 机器面端点从任何公开接口都不再可达。

配置收敛为一个变量：把 `EVELAND_PUBLIC_ORIGIN` 设为浏览器可见 Origin。`BETTER_AUTH_URL`、`WEB_ORIGIN` 与 `EVELAND_IDENTITY_ISSUER` 由它派生（每个仍可显式覆盖）；`NEXT_PUBLIC_API_URL` 已移除——浏览器始终同 Origin 调用 API，web 构建不再烘焙任何地址。

对存量安装：

1. 把 `.env` 中的各服务 URL 替换为一个 `EVELAND_PUBLIC_ORIGIN`。
2. 反向代理收敛为单一 upstream `127.0.0.1:17300`（Wildcard Agent 路由与平台 Host 路由共用它），并在防火墙上关闭旧的 Dashboard/API 端口。
3. **Issuer 迁移**：Caller Token Issuer 必须保持稳定。旧 Issuer 是 API Origin 的存量安装二选一：显式设置 `EVELAND_IDENTITY_ISSUER` 为旧值保留它（Agent 对新旧 Token 都继续验证；`/.well-known/*` 必须在该 Origin 上保持可达）；或切换到派生的前门 Issuer，并接受所有消费方 Chat 服务与 Agent Verifier 需同步更新——Worker 会在下一次 Reconcile 时把新 Issuer 重新注入 Deployment。
4. 重新构建 web 应用并重启所有组件。

## Identity 与 Catalog 路径迁入 `/api`

Issuer 锚定的公开端点从 origin 根迁入 `/api` 命名空间，不设过渡 alias：

| 旧路径                        | 新路径                   |
| ----------------------------- | ------------------------ |
| `/identity/*`                 | `/api/identity/*`        |
| `/identity/internal/continue` | `/api/identity/continue` |
| `/agent-catalog`              | `/api/agent-catalog`     |

`/.well-known/jwks.json` 与 `/api/auth/*` 不变。`eveland_identity` Cookie 的
`Path` 随路由一起迁移（既有 Session 重新登录即可）。对既有安装：

1. **Agent 必须使用 `eveland` ≥ 0.6 并重建。** 旧 SDK 在 `WWW-Authenticate`
   challenge 中烤入 `${issuer}/identity/login`，该地址现在会落到
   Dashboard；平台升级后请重建并 Promote 每个 Project。
2. **在 IdP 侧重新登记 OIDC redirect URI** 为
   `<identityIssuer>/api/identity/oidc/callback`（Settings → System →
   Identity 会显示准确值）。
3. 更新所有指向公开 origin 上 `/agent-catalog` 或 `/identity/*` 的外部聊天
   客户端配置。

同一系列中，Dashboard 自身的浏览器 API 也告别了 `/api/eveland/<subtree>`
隧道：API 现在把整个公开面原生注册在 `/api/*` 下，前门对该命名空间 verbatim
转发（Allowlist 退役——机器面留在根 `/internal/*`，前门永不转发它）。此变更
对运维者与外部客户端不可见；只有脚本化使用过 `/api/eveland/...` URL 的自定义
工具需要去掉该前缀。

## Better Auth Account Issuer

内置的 Better Auth 1.7 线在凭据登录时匹配新的 `auth_accounts.issuer` 列。迁移 `0058` 以内联 `DEFAULT 'local:credential'` 添加该列，因此按常规顺序执行即可——**先迁移、再重启 API**；回滚到升级前的 checkout 也能继续正常写入账号（旧代码不写该列，默认值补齐）。

升级前先验证新登录逻辑依赖的凭据不变量（所有受支持的写入路径都满足；计数非零说明存在手工修改过的行）：

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM auth_accounts WHERE provider_id='credential' AND account_id<>user_id"
```

## CLI device authorization 表

迁移 `0059` 创建支撑 `eveland login`（RFC 8628 device flow + scoped OAuth access
token）的 `auth_device_codes` 与 `oauth_*` 表。它只创建新表——按常规顺序**先迁移、
再重启**即可，回滚不受影响（旧代码不触碰这些表）。API 启动时会播种并重申
`eveland-cli` OAuth client 行；请勿手工编辑该行。

## 日志 tail/cursor 序列列

迁移 `0060` 给 `logs` 表加单调 `seq` 列，支撑 CLI 使用的有界日志读取协议
（`limit` 取尾、`after` 游标），用基于 seq 的索引替换旧 `(project_id,
created_at)` 索引，并按 `(created_at, id)` 对历史行做确定性回填。

**这是一次对 `logs` 表 stop-the-world 的迁移。**整份迁移在单一事务中执行，
加列取得的排他锁会一直持有到全表回填提交为止：期间所有日志读写——包括构建
与运行时日志的追加——全部阻塞，时长与日志历史成正比。请在静默窗口执行，
或先停平台组件（最稳妥的顺序：停止 → migrate → 重启）。分阶段语句的目的是
单遍写入与确定性排序，不是让迁移变成在线操作。

## Session 身份唯一索引

迁移 `0061` 让 `sessions(project_id, eve_session_id)` 成为唯一索引，由 schema
保证每次 OTLP ingest 和每次 continuation 都据以解析的 Session 身份。此前的安装
可能存有重复键对（Playground 完成或 ScheduleRun 完成与 ingest 竞争所致）；迁移
会先按平台自身 placeholder 合并的规则折叠它们，再建索引：较老的行存活，较新行的
node、event（重新编号排在存活行之后）、usage 行和 ScheduleRun 链接迁到存活行上，
usage 计数求和，元数据空缺由被吸收的行补齐。

当两行携带同一个 model usage step 时迁移会拒绝执行（hint 中给出列出问题行的
查询），因为折叠会重复计数。删掉较新 Session 重复的 usage 行（或该 Session）后
重新执行。升级前可先检查是否存在重复：

```sql
select project_id, eve_session_id, count(*)
from sessions
where eve_session_id is not null
group by 1, 2
having count(*) > 1;
```

## Linux 上的 Docker Agent Runtime 已下线

`docker-worker` Compose Profile 已移除，Linux 生产只支持 systemd Agent
Runtime。`EVELAND_RUNTIME=docker` 仍然是开发环境与 macOS Appliance 的
Runtime——只有 Linux 生产形态不再支持它。

仍在 Linux 上运行 Docker Runtime Agent 的安装必须在升级**之前**完成迁移：

1. 排空并停止每一个 Docker Deployment。每个 Deployment 都记录着创建它的
   `runtimeKind`，生命周期操作按该记录值解析适配器，因此遗留在 systemd 宿主机
   上的 Docker Deployment 会以一次记录在案的 Job 失败大声报错——混合宿主机是
   可见的，但从不是受支持的拓扑。
2. 按[安装宿主机 Worker](/zh/docs/production/worker) 与
   [安装 Workflow Dispatcher](/zh/docs/production/workflow-dispatcher) 安装宿主机
   Worker 和 Workflow Dispatcher。
3. 重新部署每个 Project，让它的 Deployment 在 systemd Runtime 下重建。

生产 Overlay 现在把基础文件中的开发 Worker 门控在一个生产命令永不启用的
Profile 之后（与 Workflow Dispatcher 一致），因此合并后的配置不可能启动第二个
Runtime 控制器。

## 遗留的按 Project Workflow 残余

每个 Release 都基于共享、External-only Workflow World 构建，生产 Worker 缺少 `EVELAND_WORKFLOW_WORLD_URL` 时拒绝启动。带有共享 World 之前历史的安装可能仍保留遗留的按 Project Workflow 配置：

- 只在仍有遗留 Project 处于删除过程中时保留 `WORKFLOW_POSTGRES_URL`（与 `WORKFLOW_POSTGRES_BOOTSTRAP_URL`）——删除遗留 Project 时才会 Drop 其派生的 `eveland_wf_<project>_<digest>` 数据库。一旦没有任何保留 Deployment Attestation 为 Legacy World、且 `pg_database` 中除共享 World 本身外不再有 `eveland_wf_*` 数据库，即可取消这两个变量；遗留 Stream Retention Sweep（`EVELAND_WORKFLOW_SWEEP_*`）随之无事可做。孤立的 `eveland_wf_*` 数据库可用标准 Postgres 工具 Drop。External-only 安装永远不设置这些变量。

## 深入参考

- [备份与恢复](/zh/docs/operations/backup-restore)：升级前后的完整数据备份与灾难恢复流程
- [Eve 兼容性窗口](/zh/docs/reference/eve-compatibility)：平台支持的 Eve 版本范围与依赖演进
- [运行时与资源管理](/zh/docs/operations/runtime)：版本升级时的实例生命周期与 Attestation 验证
