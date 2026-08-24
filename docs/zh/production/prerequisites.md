---
title: 准备宿主机
description: 安装前准备 Linux 用户、目录、Sandbox 工具链、存储与数据库访问。
---

使用带有 systemd 的 Linux 宿主机；Eveland 已在 Ubuntu 24.04 验证。Worker 将下述完整工具链视为部署契约，缺失任何一项都会拒绝启动。

## 安装工具链

安装 Node.js 24（例如 NodeSource），然后安装固定版本的包管理器 Shim：

```bash
sudo corepack enable
sudo corepack install --global pnpm@11.7.0
```

安装宿主机拥有的 Sandbox 工具链。Ubuntu 基础镜像恰好自带其中部分命令，但 Worker Preflight 检查的是完整集合：

```bash
sudo apt-get install -y apparmor bash bubblewrap ca-certificates curl docker.io findutils git grep jq python-is-python3 python3 python3-pip ripgrep unzip zstd
```

`git` 无论如何都是必需的：Worker 通过 `git clone` 执行源码导入。

## 配置 bubblewrap 与 AppArmor

Ubuntu 打包的 bubblewrap **不带** AppArmor Profile，而 Ubuntu 默认设置 `kernel.apparmor_restrict_unprivileged_userns=1`，会阻止未受限的非 root 进程创建 User Namespace。构建 Sandbox（以非特权构建用户运行）与 Agent Exec Sandbox（以非特权 Deployment 用户运行）恰好都是这种进程，因此都需要一个授予 `bwrap` `userns` 权限的 Profile：

```
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/bwrap>
}
```

将其保存为 `/etc/apparmor.d/bwrap`，并用 `apparmor_parser -r -W /etc/apparmor.d/bwrap` 加载（可安全重复执行；它会替换已加载的 Profile）。若发行版的 bubblewrap 包自带 Profile，或宿主机已关闭该 sysctl，则完全不需要这一步。

## 创建用户与目录

- 创建空目录 `/workspace`：`sudo install -d -m 0755 /workspace`。bwrap 会把每个 Sandbox Session 目录绑定到 Sandbox 内部的 `/workspace`，但无法自行创建该挂载点，因为被沙箱化的进程会先以只读方式绑定宿主机根目录。
- 创建 Artifact 访问用户及同名组：
  `sudo useradd --system --user-group --home-dir /var/lib/eveland-app --create-home eveland-app`。
  每个 Deployment 使用自己的 systemd `DynamicUser` 运行；这些身份仅把 `eveland-app` 作为主访问组，用于显式绑定的 Release、Cache 与 Policy 路径。
- 创建第二个构建服务用户：
  `sudo useradd --system --home-dir /var/lib/eveland-build --create-home eveland-build`。
  依赖生命周期脚本（`npm ci`/`npx eve build`）在构建 Sandbox 内以该用户运行，绝不以 root 运行。
- 创建绝对数据根目录，通常为 `/var/lib/eveland`。API 挂载路径与 Worker 的 `EVELAND_DATA_DIR` 必须使用完全相同的绝对路径。

Worker 本身必须以 root 运行（它驱动 `systemd-run`、`systemctl` 与 `chown`），安装步骤见[安装宿主机 Worker](/zh/docs/production/worker)。

## 准备 Postgres

生产环境使用两个数据库，通常位于同一实例：

- **平台数据库**（`DATABASE_URL`）——持有 Project、Deployment、Job 与认证数据。配置专用角色。
- **共享 Workflow 数据库**（`EVELAND_WORKFLOW_WORLD_URL`）——一个数据库为所有 Project 承载 `@evelandhq/workflow-world`，内部按 `tenant_id` 隔离。生产环境必需：缺失时 Worker 启动直接失败（Fail Closed），API 也读取同一 URL 校验 World 的 Cluster Identity。Worker 启动与 Tenant Provisioning 会自动应用所有待执行的 Workflow World Migration，由 PostgreSQL Advisory Lock 串行化；当宿主机与 Deployment 通过不同地址访问该数据库时，设置 `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL`。

不要创建每项目独立的 Workflow 数据库：共享 World 已取代它们。遗留的 `WORKFLOW_POSTGRES_URL` 只与仍在删除共享 World 之前 Project 的安装相关——参见[升级与回滚](/zh/docs/operations/upgrades)。

在第一个真实负载之前，按[容量规划](/zh/docs/operations/capacity)确定 `max_connections` 与每 Deployment 连接池预算，并将两个数据库与数据根目录纳入备份计划——参见[备份与恢复](/zh/docs/operations/backup-restore)。

## 运行 Preflight

在 Worker Checkout 中运行独立检查：

```bash
pnpm --filter @evelandhq/worker exec tsx src/integration/preflight-check.ts
```

它一次性验证完整宿主机契约：带 systemd 的 Linux、以 root 运行、绝对路径的 `EVELAND_DATA_DIR`、`PATH` 上的 `systemd-run`、`systemctl`、`runuser`、`docker`、`ss` 与 `ps`、完整 Sandbox 工具链（`bash`、`node`、`npm`、`pnpm`、`rg`、GNU `grep`/`find`、`git`、`curl`、`jq`、`python`/`python3`、`pip`/`pip3`、`unzip`、`zstd`）、`bwrap`（除非 `EVELAND_BUILD_SANDBOX=none`）、应用用户与构建用户存在、`/workspace` 目录存在、`@evelandhq/sandbox-bwrap` 可解析，以及应用用户可以遍历数据目录。

它会一次报告所有失败项，而不是在第一项就停止。输出 `PREFLIGHT OK` 之前不要继续。

继续[安装核心服务](/zh/docs/production/core-services)。

## 深入参考

- [生产架构概览](/zh/docs/production)：核心服务、宿主机 Worker 与 systemd 拓扑
- [为什么自研 bubblewrap 沙箱](/zh/docs/reference/design/sandbox)：AppArmor 配置与沙箱自检决策
- [容量规划](/zh/docs/operations/capacity)：单机硬件资源评估与 Postgres 连接预算
- [故障排查](/zh/docs/reference/troubleshooting#worker-无法启动)：Preflight 常见报错诊断与解决步骤
