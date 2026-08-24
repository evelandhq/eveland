---
title: 安装宿主机 Worker
description: 将特权 Worker 安装为 systemd Service，并连接到核心服务。
---

Worker 是唯一的 Runtime Controller。生产环境将它放在宿主机上，从而避免 API 与 Agent Gateway 获得 systemd 或 Docker Controller 权限。

## 安装 Checkout

Worker 以 root 从自己的 Checkout `/opt/eveland` 运行（见 `infra/systemd/eveland-worker.service`）。应用与核心服务相同的 `vX.Y.Z` Tag 并安装冻结 Lockfile：

```bash
cd /opt/eveland
git fetch --tags origin
git checkout vX.Y.Z
pnpm install --frozen-lockfile
```

`@evelandhq/sandbox-bwrap` 是唯一其编译产物会被 Vendor 进每个 Agent Release 的依赖，它以预构建形式从 npm 发布并由 Lockfile 固定。冻结安装因此获得该 Tag 测试时使用的精确 Backend；不存在单独的 Sandbox Backend 构建步骤。

## 安装 Service

```bash
sudo install -d -m 0750 /etc/eveland
sudo cp infra/systemd/eveland-worker.env.example /etc/eveland/eveland-worker.env
sudo cp infra/systemd/eveland-worker.service /etc/systemd/system/
```

启动 Service 前先配置 Environment File，然后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eveland-worker
```

## 配置 Environment File

`infra/systemd/eveland-worker.env.example` 注释了每一项。必须与其他组件保持一致的值：

- `EVELAND_RUNTIME=systemd` 与 `NODE_ENV=production`。`NODE_ENV=production` 本身就会把 Runtime 默认为 systemd，但保留显式值，让该文件无歧义地记录宿主机的 Runtime。
- `EVELAND_DATA_DIR=/var/lib/eveland`——与 API 容器挂载完全相同的绝对路径。
- `DATABASE_URL`——平台数据库。
- `EVELAND_WORKFLOW_WORLD_URL`（必要时加 `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL`）——共享 Workflow 数据库；必须与 Dispatcher 的值相同。
- `APP_SECRET_KEY`——必须与 API 的值一致。轮换后需重新部署每个 Agent Deployment，使其遥测凭证由新 Key 签名。
- `EVELAND_GATEWAY_SERVICE_TOKEN`、`EVELAND_GATEWAY_INTERNAL_URL`——Agent Gateway Service Authentication。
- `EVELAND_SCHEDULER_RUNTIME_SECRET`、`EVELAND_SCHEDULER_DISPATCH_SECRET`、`EVELAND_SCHEDULER_REDEEM_URL`——Scheduler Authentication；其中 Runtime Secret 还必须与 Dispatcher 的值一致。
- `EVELAND_IDENTITY_ISSUER`、`EVELAND_IDENTITY_JWKS_URL`——与 API 相同的稳定 Issuer；JWKS 可用宿主机 Loopback，因为 systemd Agent 就运行在本机。
- `EVELAND_AGENT_BASE_DOMAINS`、`EVELAND_OTLP_SERVICE_TOKEN`、`EVELAND_RELEASE_CHANNEL`、`EVELAND_REVISION`——与核心服务对齐。

每 Deployment 资源上限（`EVELAND_MEMORY_MAX`、`EVELAND_CPU_QUOTA`、`EVELAND_TASKS_MAX`）与所有可选项见[环境变量参考](/zh/docs/reference/environment-variables)；按[容量规划](/zh/docs/operations/capacity)确定取值。

## 构建信任边界

构建一个 Project 会在构建 Sandbox 内以非特权构建用户（`EVELAND_BUILD_USER`，默认 `eveland-build`）执行该 Project 的依赖生命周期脚本（`pnpm install`/`npm ci`/`npm install`，例如 `postinstall`），绝不以 root 执行。导入的 Project 及其完整依赖树只被信任到该 Sandbox 边界为止：Release 目录与共享 npm Cache 之外一切不可写，Eveland 数据目录（其他 Project 的构建、源码与解密后的 Secret Env 文件）被完全隐藏，无论 Sandbox 内是哪个用户。宿主机其余文件系统对构建保持只读可见，网络访问保留。`EVELAND_BUILD_SANDBOX=none` 会关闭该 Sandbox，不推荐。

Worker Secret 由另一套机制隐藏：Worker 自身环境（`APP_SECRET_KEY`、`DATABASE_URL` 及其 `process.env` 其余内容）否则会被构建子进程继承，并可通过 `/proc/self/environ` 读取。两种构建模式都改为从固定白名单——`PATH` 与 `npm_config_cache`——构造子进程环境，因此任何 Worker Secret 都不会进入构建。`HOME` 不在白名单上，因为 `runuser` 在用户切换时会重置它；它在切换之后被注入，指向 Release 目录。白名单还刻意丢弃运维方代理配置（`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`、`npm_config_registry`）：需要代理访问 npm Registry 的宿主机目前需要一个无需环境变量代理即可访问的 Mirror。

Project 自己的 Agent Environment 会加入该白名单，但只限 `variable` 条目——`secret` 绝不加入，无论来自 Project 环境还是 Shared Agent Environment。`npx eve build` 会导入 Project 的 Agent 配置以编译 Release Manifest，若配置从 `process.env` 解析编译期值，否则会把其书写的 Fallback 冻结进该 Release 报告的每一个 Turn。`variable` 是运维方声明的非敏感配置，可以进入不受信任生命周期脚本可读的边界；`secret` 不可以，只到达已部署进程。

两组名称始终归平台所有；声明其中任一名称的条目会被从构建中丢弃，并在构建日志打出 `WARNING`——绝不静默：

- **`PATH`、`HOME`、`NPM_CONFIG_CACHE`**——构建自身的工具链。`NPM_CONFIG_CACHE` 是因为 npm 会不区分大小写地把它与 `npm_config_cache` 一起读取，使用它的条目可能把共享 Cache 重定向出去。这些名称仍会正常到达已部署进程。
- **平台在运行时保留的所有名称**——`NODE_ENV`、`EVELAND_PROJECT_ID`、`EVELAND_IDENTITY_ISSUER`、`EVELAND_IDENTITY_JWKS_URL`、`EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES`、`EVELAND_SANDBOX_MAX_OUTPUT_BYTES`、`EVELAND_SANDBOX_RUN_TIMEOUT_MS`、`EVELAND_SCHEDULER_REDEEM_URL`、`EVELAND_SCHEDULER_RUNTIME_SECRET`、`EVELAND_WORKFLOW_RUNNER`、`EVELAND_WORKFLOW_STREAM_COMPACTION`、`EVELAND_WORKFLOW_WORLD_URL`、`WORKFLOW_POSTGRES_URL`、`WORKFLOW_POSTGRES_MAX_POOL_SIZE`（与 `apps/worker/src/runtime/reserved-environment.ts` 保持一致，由测试锁定）。Runtime 最后应用这些值，采用 Project 值的构建会编译出被部署进程随后覆盖的内容。`NODE_ENV` 无论宿主机自身取值如何都会从每次构建中丢弃：`npm ci` 与 `pnpm install --frozen-lockfile` 在 `NODE_ENV=production` 下都会省略 devDependencies，从而剥离 Project 自己的构建工具链。

由于 Release 不可变，修改 `variable` 只在下一次部署时刷新编译后的 Manifest——单纯的环境变更只会让存活 Deployment 在其现有 Release 上重启。在 Docker Runtime 上，这些变量以 `--build-arg` 传入并出现在镜像构建元数据中；`ARG` 声明位于依赖安装层之后，因此 Docker 上只有预发现、Extension Integrator、`npx eve build` 与最终 Discovery 能读到它们。systemd Runtime 在同一个 Shell 中把它们同时暴露给安装与构建。

## 绝不切换已解析的 Runtime

> **警告：绝不在有存活 Deployment 的宿主机上切换 `EVELAND_RUNTIME`。**

每个 Deployment 都记录创建它的 Adapter 的 `runtimeKind`，stop、restart 与 delete 始终从该记录值解析 Adapter。当 `runtimeKind` 与实际存在的进程不符时，停止操作会解析到错误的 Adapter：旧进程永远不会被停止并继续占用端口，重新部署会 Crash Loop 或悄悄留下两个版本同时运行，健康检查还可能对陈旧进程误判通过。

将**已解析的** Runtime 视为每台宿主机在开通时固定的属性——并记住它有两种改变方式：翻转 `EVELAND_RUNTIME`，或在 `EVELAND_RUNTIME` 未设置的宿主机上设置 `NODE_ENV=production`。Preflight 会大声捕获意外翻转，但无论如何都要先排空——切换前停止并移除**所有** Deployment：

```bash
# 正在迁出的 systemd 宿主机：
systemctl stop 'eveland-*'
systemctl reset-failed 'eveland-*'

# 正在迁出的 docker 宿主机：
docker rm -f $(docker ps -aq --filter "name=eveland-")
```

只有旧 Runtime 不再残留任何 `eveland-*` 进程后，才能以新 Runtime 启动 Worker。

## 验证权限边界

- Worker 以 root 运行，控制 `systemd-run`、`systemctl` 与文件所有权。
- Build 在配置的 Build Sandbox 内以非特权构建用户运行。
- Eve 进程以每 Deployment 独立的 systemd Dynamic User 运行，附带应用访问组。
- Worker 没有公开监听端口。
- Project Secret 只进入目标进程专属、由 root 管理的 `0600` EnvironmentFile。

生产 Preflight 或 Durable Workflow 配置不完整时，Worker 会拒绝接收 Job。继续之前检查 Service Journal 与已脱敏的 Worker Configuration Snapshot（数据根下的 `diagnostics/worker-configuration.json`，在 **Settings → About** 中呈现）。

下一步[安装 Workflow Dispatcher](/zh/docs/production/workflow-dispatcher)。
