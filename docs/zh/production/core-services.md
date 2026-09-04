---
title: 安装核心服务
description: 安装稳定 Eveland Release，并以宿主机 systemd unit 运行 API、Agent Gateway、Dashboard、Worker 与 Workflow Dispatcher。
---

稳定安装必须运行精确的 `vX.Y.Z` Tag，而不是可变的 `main` Checkout。不要将 `main` 当作稳定实例部署。

每个平台进程都以宿主机 systemd unit 运行。Docker 只剩下托管 OpenTelemetry Collector，以及——除非你自带 PostgreSQL——那个自带的数据库。

## 安装指定版本

```bash
git fetch --tags origin
git checkout vX.Y.Z
pnpm install --frozen-lockfile
pnpm --filter @evelandhq/web build
pnpm --filter @evelandhq/api db:migrate
```

在把任何进程滚动到新 Tag 之前，先应用数据库 Migration。Dashboard 构建产物是宿主机制品：`eveland-web.service` 直接服务它，没有构建产物就拒绝启动。

## 配置平台环境

一套安装只有一份配置文件——`eveland-ctl` 装置下是 `/opt/eveland/etc/eveland.env`，手工安装则是本地 `.env`（已 gitignore）。至少要设置公开 Origin 与所有生产 Secret：

- `EVELAND_PUBLIC_ORIGIN`——唯一的浏览器可见 Origin（前门）。Better Auth URL、认证 CORS Origin 与 Identity Issuer 都由它派生；单项覆盖（`WEB_ORIGIN`、`BETTER_AUTH_URL`、`EVELAND_IDENTITY_ISSUER`）存在但很少需要。
- `EVELAND_IDENTITY_ALLOWED_ORIGINS`——精确的聊天浏览器 Origin，仅在使用外部聊天前端时需要。
- `EVELAND_AGENT_BASE_DOMAINS`——Wildcard Agent Domain，例如 `agents.example.com`。
- `DATABASE_URL` 与 `EVELAND_WORKFLOW_WORLD_URL`——各自只有一个地址，因为它们的每一个读取方现在都是同一网络命名空间里的宿主机进程。自带数据库与外置 PostgreSQL 的取舍见[准备宿主机](/zh/docs/production/prerequisites)。
- `BETTER_AUTH_SECRET`、`APP_SECRET_KEY`、`EVELAND_GATEWAY_SERVICE_TOKEN`、`EVELAND_GATEWAY_AFFINITY_SECRET`、`EVELAND_SCHEDULER_RUNTIME_SECRET`、`EVELAND_SCHEDULER_DISPATCH_SECRET`、`EVELAND_OTLP_SERVICE_TOKEN`——彼此独立的长随机值。绝不沿用开发 Fallback；在显式 `NODE_ENV=development` 之外，缺失这些值时服务直接拒绝启动（Fail Closed）。

每个变量的定义、默认值与使用方见[环境变量参考](/zh/docs/reference/environment-variables)。

## 启动基础设施

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d otel-collector postgres
```

如果这套安装使用你自己的 PostgreSQL，就去掉 `postgres`——它被门控在一个 Compose Profile 之后，因此不带服务名的 `up -d` 不会在你配置的集群旁边再起一个。

这会启动**托管 OpenTelemetry Collector**，其由 Worker 生成的配置从 `/var/lib/eveland/otel` 以只读方式挂载。Collector 留在 Docker Bridge 上，因为 Docker Runtime 需要把它接入每个 Agent 的私有遥测网络；它通过 `host.docker.internal` 访问宿主机上的 API，而 API 在同一地址上绑定第二个 Listener，只接受 Health、Collector Observation、Agent JWKS 与 Scheduler Channel 路径。

Overlay 不启动任何平台服务。基础文件中的开发版 API、Agent Gateway、Dashboard、Worker 与 Workflow Dispatcher 各自被门控在一个此命令永不启用的 Profile 之后——合并后的生产配置因此不可能启动任何一个的第二份。

**发布到宿主机的 `17310` 绝不能从宿主机之外访问。** 自带数据库的存在是为了让宿主机服务——API、Agent Gateway、Worker、Workflow Dispatcher 以及每个已部署的 Agent 进程——通过 Loopback 访问它，而它携带的是众所周知的默认凭据。必须在宿主机防火墙上阻断所有非本地网络对它的访问——参见[网络](/zh/docs/production/networking)。

## 安装平台 unit

`eveland-ctl install --systemd` 会为每个平台进程渲染并启用一个 unit：

| Unit                                  | 运行身份           | 可写路径                             |
| ------------------------------------- | ------------------ | ------------------------------------ |
| `eveland-api.service`                 | `eveland-platform` | `EVELAND_DATA_DIR`                   |
| `eveland-gateway.service`             | `DynamicUser`      | 无                                   |
| `eveland-web.service`                 | `eveland-web`      | `apps/web/.next`（其运行时缓存）     |
| `eveland-worker.service`              | `root`             | 数据根目录、systemd、Deployment 用户 |
| `eveland-workflow-dispatcher.service` | `DynamicUser`      | 无                                   |

每个有监听端口的服务都以非特权身份运行，配以 `ProtectSystem=strict`、只读源码树和显式的 `ReadWritePaths`，而且**没有任何两个共用同一个 uid**。这正是「每服务一份环境文件」能成为真实边界、而不只是约定的原因：同 uid 的进程可以互相读取 `/proc/<pid>/environ`，公网前门一旦与 API 共用用户，整份平台配置就只隔着一次读取。API 与 Dashboard 保留固定用户，因为它们拥有跨重启存活的文件；Gateway 什么都不拥有，所以用每次开机回收的 `DynamicUser`。Worker 是 root 是有意为之：它是唯一被允许构建不可信项目代码、并驱动 `systemd-run`/`systemctl`/`chown` 的组件——每个 Eve Deployment 正是这样获得自己的非特权 `DynamicUser` 的。每个 unit 读取 `etc/` 下自己的环境文件，这些文件在每次启动时都从 `etc/eveland.env` 重新渲染——要改就改后者，不要改渲染产物。

手工安装时，同样的 unit 见[安装宿主机 Worker](/zh/docs/production/worker) 与[安装 Workflow Dispatcher](/zh/docs/production/workflow-dispatcher)。

## 对齐 Release 身份

在平台配置中设置 `EVELAND_RELEASE_CHANNEL=stable`，并把 `EVELAND_REVISION` 设为 `git rev-parse --short=12 HEAD` 的输出，然后重启这些 unit。刻意测试 `main` 的实例改用 `EVELAND_RELEASE_CHANNEL=edge` 及其精确 Revision。`eveland-ctl start` 与 `eveland-ctl update` 都会替你从 Checkout 固化这两个值。

需要认证的 Dashboard **Settings → About** 页面对比 Dashboard 与 API 的 Build Identity；API 与 Agent Gateway 也通过公开 `/health` 暴露它，Worker 在启动时打印它，Dispatcher 则在其 Registration 上报告它。只要其中任何一处不一致，就不能宣称安装（或后续升级）完成。团队 Admin 可以在同一 About 页面检查各组件白名单化的有效配置；Secret 只以固定掩码显示。

下一步[安装宿主机 Worker](/zh/docs/production/worker)。

## 深入参考

- [生产架构概览](/zh/docs/production)：受支持的核心服务、宿主机 Worker 与 systemd 拓扑
- [配置参考](/zh/docs/reference/configuration)：各组件环境变量归属与默认值
- [安全模型](/zh/docs/operations/security)：网络隔离、凭证保护与进程特权边界
