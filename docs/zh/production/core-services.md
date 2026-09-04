---
title: 安装核心服务
description: 安装稳定版本 Eveland，并以宿主机 systemd unit 启动核心控制面服务。
---

生产环境请务必运行经过测试的稳定版本（如 `vX.Y.Z` Release Tag），切勿在生产环境中直接部署未经测试的 `main` 分支代码。

在 Linux 宿主机上，除辅助容器（OTel Collector 与可选的 Postgres）运行在 Docker 内外，平台的所有核心进程均作为独立的 systemd 服务运行。

## 1. 检出稳定版本并构建

```bash
git fetch --tags origin
git checkout vX.Y.Z
pnpm install --frozen-lockfile
pnpm --filter @evelandhq/web build
pnpm --filter @evelandhq/api db:migrate
```

_注意：在启动或重启进程前，务必先执行 `db:migrate` 确保数据库结构最新。Dashboard 前端构建产物（`apps/web/.next`）由宿主机服务直接托管，未构建将无法启动。_

## 2. 配置平台全局环境变量

对于使用 `eveland-ctl` 管理的安装，配置文件路径为 `/opt/eveland/etc/eveland.env`；手动部署时为项目根目录的 `.env`。核心必要配置如下：

```ini
# 公开访问入口（前门域名，不带尾部斜杠）
EVELAND_PUBLIC_ORIGIN=https://console.example.com

# Agent 泛解析域名（客户端与 API 访问 Agent 使用）
EVELAND_AGENT_BASE_DOMAINS=agents.example.com

# 数据库连接地址
DATABASE_URL=postgres://eveland:password@127.0.0.1:17310/eveland
EVELAND_WORKFLOW_WORLD_URL=postgres://eveland:password@127.0.0.1:17310/eveland

# 平台安全密钥（请使用 openssl rand -hex 32 生成高强度独立随机串）
BETTER_AUTH_SECRET=your_auth_secret_32_bytes_min
APP_SECRET_KEY=your_app_encryption_key_32_bytes
EVELAND_GATEWAY_SERVICE_TOKEN=your_gateway_service_token
EVELAND_GATEWAY_AFFINITY_SECRET=your_affinity_secret
EVELAND_SCHEDULER_RUNTIME_SECRET=your_scheduler_runtime_secret
EVELAND_SCHEDULER_DISPATCH_SECRET=your_scheduler_dispatch_secret
EVELAND_OTLP_SERVICE_TOKEN=your_otlp_service_token
```

_完整变量列表与默认值说明请参考[环境变量参考](/zh/docs/reference/environment-variables)。_

## 3. 启动基础设施容器

执行以下命令拉起托管的 OpenTelemetry Collector（以及内置的 Postgres）：

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d otel-collector postgres
```

_(如果使用了外部自有 PostgreSQL 集群，可从命令中去掉 `postgres`)_

**安全警示**：如果使用了自带的内置 Postgres，其默认映射端口 `17310` 仅供本机宿主机进程回环访问，**严禁在宿主机公网防火墙上放行 17310 端口**。

## 4. 安装与配置 systemd 核心服务

平台各进程在 systemd 中以最小必要权限独立运行：

| 服务 Unit                             | 运行身份                    | 职责与可写路径                               |
| :------------------------------------ | :-------------------------- | :------------------------------------------- |
| `eveland-api.service`                 | `eveland-platform` (非特权) | 控制面 API；仅可写 `EVELAND_DATA_DIR`        |
| `eveland-gateway.service`             | `DynamicUser` (临时无特权)  | 统一接入网关；文件系统完全只读               |
| `eveland-web.service`                 | `eveland-web` (非特权)      | 控制台前端；仅可写自身运行时构建缓存 `.next` |
| `eveland-worker.service`              | `root` (系统特权控制器)     | 构建沙箱编排与进程管理；无公网监听端口       |
| `eveland-workflow-dispatcher.service` | `DynamicUser` (临时无特权)  | 持久化工作流外置调度；文件系统只读           |

使用 `eveland-ctl` 时可一键安装：

```bash
eveland-ctl install --systemd
```

如需手动安装各服务 unit 模板，请继续阅读[安装宿主机 Worker](/zh/docs/production/worker) 与 [安装 Workflow Dispatcher](/zh/docs/production/workflow-dispatcher)。

## 5. 校验组件版本一致性

启动各服务后，登录控制台在 **Settings → About** 中核对组件信息：

- API、Dashboard、Worker 与 Dispatcher 的 `version` 和 `revision` 应完全一致。
- 确认各服务报告的 `channel` 为 `stable`。

下一步：[安装宿主机 Worker](/zh/docs/production/worker)。
