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

## 选择 PostgreSQL

一套安装要么运行自带的数据库，要么使用你自己提供的。`eveland-ctl` 在首次启动时问一次，把答案记进 `install.json`；之后每条命令都按这条记录分支，而不是从连接串的形状去猜。

- **自带**——Compose 的 `postgres` 服务，发布在宿主机回环 `17310`。无需准备，升级时在它自己的容器内 dump，客户端与服务端版本天然一致。适合单机安装。
- **自己的**（任何你会为之被叫醒的环境都推荐）——托管实例或你已经在运维的服务器，这样备份、故障切换与版本升级都沿用你既有的做法。在首次启动的提示里填入其连接 URL，或在第一次 `eveland-ctl start` 之前把 `DATABASE_URL` 放进环境变量。

两个方向都没有自动兜底。如果你指定了一台服务器而它没有应答，安装会带着连接错误停在那里，而不是悄悄在旁边起一个自带容器——两个集群、各持一半数据，是不值得走到的状态。

平台对你自己服务器的要求，是一个拥有两个数据库的角色（`eveland-ctl` 渲染时把两者放在同一个库里）：

- **平台数据库**（`DATABASE_URL`）——持有 Project、Deployment、Job 与认证数据。
- **共享 Workflow 数据库**（`EVELAND_WORKFLOW_WORLD_URL`）——一个数据库为所有 Project 承载 `@evelandhq/workflow-world`，内部按 `tenant_id` 隔离。生产环境必需：缺失时 Worker 启动直接失败（Fail Closed），API 也读取同一 URL 校验 World 的 Cluster Identity。Worker 启动与 Tenant Provisioning 会自动应用所有待执行的 Workflow World Migration，由 PostgreSQL Advisory Lock 串行化。

它们的每一个读取方——API、Agent Gateway、Worker、Dispatcher 与每个 Deployment——都是同一网络命名空间里的宿主机进程，因此每个 URL 只有一个地址。`EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL` 只在平台与其 Deployment 通过不同名字访问数据库时才需要，而这在 Linux 上已不再发生。

不需要 CREATEDB。Project 是共享 World 内部的租户分区；只有遗留的终止路径仍会执行 `CREATE DATABASE`。不要创建每项目独立的 Workflow 数据库：共享 World 已取代它们。遗留的 `WORKFLOW_POSTGRES_URL` 只与仍在删除共享 World 之前 Project 的安装相关——参见[升级与回滚](/zh/docs/operations/upgrades)。

不要在这两个数据库前面放事务级连接池代理（`transaction` 模式的 PgBouncer，以及大多数“Serverless”连接池前端）：Durable Job 队列依赖会话级的 `LISTEN`/`NOTIFY` 与 Advisory Lock，而事务级池化会静默丢掉它们。

使用自己 PostgreSQL 的安装还需要宿主机上有 `pg_dump`，因为 `eveland-ctl update` 用它做升级前备份（Debian/Ubuntu：`apt-get install postgresql-client`）。`eveland-ctl doctor` 会检查它，所以客户端缺失是一条检查结果，而不是升级到一半才失败。

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
