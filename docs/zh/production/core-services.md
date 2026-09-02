---
title: 安装核心服务
description: 安装稳定 Eveland Release 并启动 Dashboard、API、Agent Gateway、Postgres 与 Collector。
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
- `BETTER_AUTH_SECRET`、`APP_SECRET_KEY`、`EVELAND_GATEWAY_SERVICE_TOKEN`、`EVELAND_GATEWAY_AFFINITY_SECRET`、`EVELAND_SCHEDULER_RUNTIME_SECRET`、`EVELAND_SCHEDULER_DISPATCH_SECRET`、`EVELAND_OTLP_SERVICE_TOKEN`——彼此独立的长随机值。绝不沿用开发 Fallback；在显式 `NODE_ENV=development` 之外，缺失这些值时服务直接拒绝启动（Fail Closed）。

每个变量的定义、默认值与使用方见[环境变量参考](/zh/docs/reference/environment-variables)。

## 启动核心服务

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

这会以生产配置启动 Dashboard、API、Agent Gateway 与 Postgres，外加来自基础 `docker-compose.yml` 的**托管 OpenTelemetry Collector**，其由 Worker 生成的配置从 `/var/lib/eveland/otel` 以只读方式挂载。

基础文件中的容器化 Workflow Dispatcher 携带的是开发配置，因此 Overlay 将它门控在一个此命令永不启用的 Profile 之后。每套安装恰好运行一个 Dispatcher：生产环境即[安装 Workflow Dispatcher](/zh/docs/production/workflow-dispatcher) 中的宿主机 Dispatcher。

Overlay 完全不启动 Worker。生产 Agent 以加固的 systemd unit 运行在[安装宿主机 Worker](/zh/docs/production/worker) 所装的宿主机 Worker 之下，而基础文件中的开发 Worker 被门控在一个此命令永不启用的 Profile 之后——合并后的生产配置因此不可能启动第二个 Runtime 控制器。

API、Agent Gateway 与 Dashboard 使用 Host Networking 运行，以便通过宿主机 Loopback 端口访问 Deployment；Postgres 保持桥接并向宿主机发布 `17310`。API 容器以完全相同的绝对路径 Bind Mount `/var/lib/eveland`，与宿主机 Worker 的 `EVELAND_DATA_DIR` 一致——参见[共享数据契约](/zh/docs/production)。

**发布到宿主机的 `17310` 绝不能从宿主机之外访问。** 它的存在是为了让宿主机服务——Worker、Workflow Dispatcher 以及每个已部署的 Agent 进程——通过 Loopback 访问数据库，而它携带的是众所周知的默认凭据。必须在宿主机防火墙上阻断所有非本地网络对它的访问——参见[网络](/zh/docs/production/networking)。

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
