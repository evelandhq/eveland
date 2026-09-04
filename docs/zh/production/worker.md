---
title: 安装宿主机 Worker
description: 将特权 Worker 安装为宿主机 systemd 服务，负责代码沙箱构建与 Agent 进程编排。
---

Worker 是 Eveland 唯一的宿主机运行时控制器（Runtime Controller）。为了严格隔离权限，它作为特权服务仅运行在宿主机上，不对公网开放任何监听端口。

## 1. 准备代码目录

Worker 运行在宿主机的 `/opt/eveland` 目录下，检出与核心服务相同的稳定版本：

```bash
cd /opt/eveland
git fetch --tags origin
git checkout vX.Y.Z
pnpm install --frozen-lockfile
```

_注意：`@evelandhq/sandbox-bwrap` 沙箱核心模块已预编译发布并在 Lockfile 中固定，冻结安装即可获得完整的沙箱能力，无需单独编译。_

## 2. 安装与启动 systemd 服务

```bash
sudo install -d -m 0750 /etc/eveland
sudo cp infra/systemd/eveland-worker.env.example /etc/eveland/eveland-worker.env
sudo cp infra/systemd/eveland-worker.service /etc/systemd/system/
```

编辑 `/etc/eveland/eveland-worker.env` 配置必要参数后，启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eveland-worker
```

## 3. 核心环境变量配置

在 `/etc/eveland/eveland-worker.env` 中，确保以下关键项与核心服务保持一致：

```ini
# 运行时类型与环境
EVELAND_RUNTIME=systemd
NODE_ENV=production

# 统一数据目录（必须与 API 的挂载路径完全一致）
EVELAND_DATA_DIR=/var/lib/eveland

# 数据库连接
DATABASE_URL=postgres://eveland:password@127.0.0.1:17310/eveland
EVELAND_WORKFLOW_WORLD_URL=postgres://eveland:password@127.0.0.1:17310/eveland

# 内部通信安全凭证（必须与核心服务一致）
APP_SECRET_KEY=your_app_encryption_key_32_bytes
EVELAND_GATEWAY_SERVICE_TOKEN=your_gateway_service_token
EVELAND_GATEWAY_INTERNAL_URL=http://127.0.0.1:17300
EVELAND_SCHEDULER_RUNTIME_SECRET=your_scheduler_runtime_secret
EVELAND_SCHEDULER_DISPATCH_SECRET=your_scheduler_dispatch_secret
EVELAND_SCHEDULER_REDEEM_URL=http://127.0.0.1:17301/api/scheduler/redeem
EVELAND_IDENTITY_ISSUER=https://console.example.com
EVELAND_IDENTITY_JWKS_URL=http://127.0.0.1:17301/.well-known/jwks.json

# 遥测与版本标记
EVELAND_AGENT_BASE_DOMAINS=agents.example.com
EVELAND_OTLP_SERVICE_TOKEN=your_otlp_service_token
EVELAND_RELEASE_CHANNEL=stable
EVELAND_REVISION=your_git_commit_sha
```

## 4. 构建与运行时安全隔离机制

### 依赖构建沙箱化

- 当执行项目依赖安装（`npm ci`/`pnpm install`）及代码打包（`npx eve build`）时，Worker 会自动在 **bubblewrap 轻量沙箱**中以非特权用户 `eveland-build` 运行。
- **环境屏蔽**：Worker 自身的敏感环境变量（如 `DATABASE_URL`、`APP_SECRET_KEY`）会自动被剥离，绝不会泄露给构建进程。
- **非敏感变量传递**：仅非敏感的项目普通环境变量（`variable`）允许在构建期被读取，用于生成配置清单；敏感密钥（`secret`）只在已部署的生产运行环境中注入。

### 运行时进程隔离

- **独立动态用户**：每个 Agent 部署启动时都会分配一个临时的 systemd `DynamicUser`，私有端口绑定在本地回环（`127.0.0.1:18000–18999`）。
- **受保护的环境变量**：运行期密钥以 root 拥有的只读文件（权限 `0600`）注入进程，确保进程间相互隔离。

## 5. 验证运行状态

检查服务运行日志，确认 Preflight 预检通过且未报错：

```bash
sudo journalctl -u eveland-worker -f
```

若服务正常运行，会在日志中打印配置快照与工作队列监听状态。

下一步：[安装 Workflow Dispatcher](/zh/docs/production/workflow-dispatcher)。

## 相关参考

- [生产架构概览](/zh/docs/production)：核心服务与 Worker 拓扑关系
- [为什么自研 bubblewrap 沙箱](/zh/docs/reference/design/sandbox)：沙箱隔离机制与设计权衡
- [容量规划](/zh/docs/operations/capacity)：单机并发构建数与内存评估
