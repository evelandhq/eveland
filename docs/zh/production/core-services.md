---
title: 安装核心服务
description: 安装稳定 Eveland Release，并针对外部 Postgres 启动 Dashboard、API、Agent Gateway 与 Collector。
---

稳定安装必须运行精确的 `vX.Y.Z` Tag，而不是可变的 `main` Checkout。不要将 `main` 当作稳定实例部署。

## 安装指定版本

```bash
git fetch --tags origin
git checkout vX.Y.Z
pnpm install --frozen-lockfile
pnpm --filter @evelandhq/api db:migrate
```

在把任何 API、Agent Gateway 或 Worker 进程滚动到新 Tag 之前，先应用数据库 Migration。

## 配置 Compose 环境

生产 Overlay 读取本地 `.env`（已 gitignore）。至少要设置公开 Origin 与所有生产 Secret：

- `WEB_ORIGIN`、`NEXT_PUBLIC_API_URL`、`BETTER_AUTH_URL`——浏览器可见的 Dashboard 与 API Origin。`NEXT_PUBLIC_API_URL` 在构建时固化进 Dashboard。
- `EVELAND_IDENTITY_ISSUER`、`EVELAND_IDENTITY_ALLOWED_ORIGINS`——稳定的 Caller Token Issuer 与精确的聊天浏览器 Origin。
- `EVELAND_AGENT_BASE_DOMAINS`——Wildcard Agent Domain，例如 `agents.example.com`。
- `DATABASE_URL`、`EVELAND_WORKFLOW_WORLD_URL`——[外部 Postgres](/zh/docs/production/prerequisites#准备外部-postgres) 上的两个数据库。两者都必须原样在 Compose 网络**与**宿主机上可连通，因为宿主机 Worker、Dispatcher 与每个 Deployment 使用的是同样的字符串；宿主机回环地址是 API 容器自己的回环，不满足这一条。两个值都要加引号（`DATABASE_URL='postgres://…'`）：Compose 会展开未加引号的 `--env-file` 值里的 `$NAME`，含 `$` 的密码到了 API 容器里是被截断的，到宿主机进程手上却是完整的。
- `BETTER_AUTH_SECRET`、`APP_SECRET_KEY`、`EVELAND_GATEWAY_SERVICE_TOKEN`、`EVELAND_GATEWAY_AFFINITY_SECRET`、`EVELAND_SCHEDULER_RUNTIME_SECRET`、`EVELAND_SCHEDULER_DISPATCH_SECRET`、`EVELAND_OTLP_SERVICE_TOKEN`——彼此独立的长随机值。绝不沿用开发 Fallback；在显式 `NODE_ENV=development` 之外，缺失这些值时服务直接拒绝启动（Fail Closed）。

每个变量的定义、默认值与使用方见[环境变量参考](/zh/docs/reference/environment-variables)。

## 启动核心服务

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

这会以生产配置启动 Dashboard、API 与 Agent Gateway，外加来自基础 `docker-compose.yml` 的**托管 OpenTelemetry Collector**，其由 Worker 生成的配置从 `/var/lib/eveland/otel` 以只读方式挂载。

Postgres 不在其中。基础文件中的开发数据库被门控在一个此命令永不启用的 Profile 之后，因为这套拓扑把 Postgres 当作[外部前置条件](/zh/docs/production/prerequisites#准备外部-postgres)：API 在 Compose 网桥上，而 Worker、Dispatcher 与每个 Deployment 在宿主机上，只有安装之外的实例才有一个三者都能连通的地址。这里再起一个 Compose 数据库就是一个没人注意的第二集群——Deployment 把 Run 写进 Dispatcher 永远不会去认领的数据库，正是这样发生的。

基础文件中的容器化 Workflow Dispatcher 携带的是开发配置，因此 Overlay 将它门控在一个此命令永不启用的 Profile 之后。每套安装恰好运行一个 Dispatcher：生产环境即[安装 Workflow Dispatcher](/zh/docs/production/workflow-dispatcher) 中的宿主机 Dispatcher。

Overlay 完全不启动 Worker。生产 Agent 以加固的 systemd unit 运行在[安装宿主机 Worker](/zh/docs/production/worker) 所装的宿主机 Worker 之下，而基础文件中的开发 Worker 被门控在一个此命令永不启用的 Profile 之后——合并后的生产配置因此不可能启动第二个 Runtime 控制器。

Agent Gateway 与 Dashboard 使用 Host Networking 运行，以便前门能通过宿主机 Loopback 端口访问 Deployment。API 留在 Compose 网络中：它不访问任何 Deployment 端口，而 Collector 必须能访问它才能投递每一条 Agent 事件，这只有共享网络才做得到。它只向宿主机发布一个仅回环的端口 `17301`，供宿主机 Worker、Workflow Dispatcher 与前门访问。API 容器以完全相同的绝对路径 Bind Mount `/var/lib/eveland`，与宿主机 Worker 的 `EVELAND_DATA_DIR` 一致——参见[共享数据契约](/zh/docs/production)。

**访问外部数据库现在是一个网络问题，而不是一个发布端口。** 实例必须在 `DATABASE_URL` 所指的地址上接受来自本机的连接，同时绝不能从公网可达：把它放在私有网络中，或用只放行本机的安全组——参见[网络](/zh/docs/production/networking)。

## 对齐 Release 身份

在三个位置设置 `EVELAND_RELEASE_CHANNEL=stable`，并把 `EVELAND_REVISION` 设为 `git rev-parse --short=12 HEAD` 的输出：

- Compose `.env`（Dashboard、API、Agent Gateway），
- `/etc/eveland/eveland-worker.env`（Worker），
- `/etc/eveland/eveland-workflow-dispatcher.env`（Workflow Dispatcher）。

从核心服务 Checkout 重启 Dashboard、API 与 Agent Gateway，从 `/opt/eveland` 重启 Worker 与 Dispatcher。刻意测试 `main` 的实例改用 `EVELAND_RELEASE_CHANNEL=edge` 及其精确 Revision。

需要认证的 Dashboard **Settings → About** 页面对比 Dashboard 与 API 的 Build Identity；API 与 Agent Gateway 也通过公开 `/health` 暴露它，Worker 在启动时打印它，Dispatcher 则在其 Registration 上报告它。只要其中任何一处不一致，就不能宣称安装（或后续升级）完成。团队 Admin 可以在同一 About 页面检查各组件白名单化的有效配置；Secret 只以固定掩码显示。

下一步[安装宿主机 Worker](/zh/docs/production/worker)。

## 深入参考

- [生产架构概览](/zh/docs/production)：受支持的核心服务、宿主机 Worker 与 systemd 拓扑
- [配置参考](/zh/docs/reference/configuration)：各组件环境变量归属与默认值
- [安全模型](/zh/docs/operations/security)：网络隔离、凭证保护与进程特权边界
