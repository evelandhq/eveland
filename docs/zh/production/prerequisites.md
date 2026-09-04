---
title: 准备宿主机
description: 生产环境前置准备：Linux 基础依赖、bubblewrap 沙箱配置、专用系统用户与数据库规划。
---

> **手工安装路径。** 本页所有步骤，[安装脚本](/zh/docs/production/install)都会自动完成。只有在必须手工安装时才需要照做。

生产环境推荐使用支持 systemd 的 Linux 宿主机（推荐 Ubuntu 24.04 LTS）。在安装平台服务前，请先完成以下基础环境准备。

## 1. 安装基础运行时与工具链

### Node.js 与包管理器

安装 Node.js 24，并通过 Corepack 启用指定版本的 pnpm：

```bash
sudo corepack enable
sudo corepack install --global pnpm@11.7.0
```

### 系统依赖与沙箱工具

Worker 需要一系列系统工具来执行源码拉取、代码打包与沙箱隔离：

```bash
sudo apt-get update && sudo apt-get install -y \
  apparmor bubblewrap ca-certificates curl docker.io \
  findutils git grep jq python-is-python3 python3 python3-pip \
  ripgrep unzip zstd
```

## 2. 配置 bubblewrap 与 AppArmor

Ubuntu 24.04 默认限制非特权进程创建用户命名空间（`kernel.apparmor_restrict_unprivileged_userns=1`）。由于构建沙箱和 Agent 执行沙箱均以非特权用户运行，需配置 AppArmor Profile 授予 `bwrap` 相应权限：

创建配置文件 `/etc/apparmor.d/bwrap`：

```text
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
```

重新加载 AppArmor 配置生效：

```bash
sudo apparmor_parser -r -W /etc/apparmor.d/bwrap
```

_(如果使用的发行版已内置对应规则或未开启该内核限制，可跳过此步)_

## 3. 创建专用用户与数据目录

- **沙箱工作区根目录**：创建 `/workspace` 目录供沙箱会话挂载：
  ```bash
  sudo install -d -m 0755 /workspace
  ```
- **应用访问用户组**：创建 `eveland-app` 系统用户与组，用于管理产物与部署缓存：
  ```bash
  sudo useradd --system --user-group --home-dir /var/lib/eveland-app --create-home eveland-app
  ```
- **专用构建用户**：创建 `eveland-build` 系统用户。项目依赖安装（如 `npm ci`）和构建命令均以该非特权用户运行，杜绝恶意脚本提权：
  ```bash
  sudo useradd --system --home-dir /var/lib/eveland-build --create-home eveland-build
  ```
- **平台数据根目录**：创建统一的数据目录（默认为 `/var/lib/eveland`）：
  ```bash
  sudo install -d -m 0755 /var/lib/eveland
  ```

## 4. 规划 PostgreSQL 数据库

Eveland 需要两个逻辑数据库（可位于同一个 Postgres 实例中）：

1. **平台控制面数据库** (`DATABASE_URL`)：持久化团队、项目、部署状态与会话事件。
2. **共享工作流数据库** (`EVELAND_WORKFLOW_WORLD_URL`)：为全平台 Agent 承载持久化任务与定时工作流（内部按 `tenant_id` 逻辑隔离）。

### 部署选择

- **自带容器方案**：使用 Compose 启动内置的 Postgres 容器（监听 `127.0.0.1:17310`），适合单机快速上线。
- **自备外部集群**：使用自有的高可用云数据库或自建集群。请确保：
  - 宿主机安装了 `postgresql-client`（用于自动备份）；
  - **切勿在前端挂载事务级连接池（如 `transaction` 模式的 PgBouncer 或部分 Serverless 代理）**，因为工作流队列强依赖会话级的 `LISTEN/NOTIFY` 与 Advisory Lock。

## 5. 运行自动化预检 (Preflight)

在 Worker 源码目录中执行预检脚本，自动验证宿主机配置是否合规：

```bash
pnpm --filter @evelandhq/worker exec tsx src/integration/preflight-check.ts
```

预检脚本会逐一检查 systemd 权限、沙箱命令可用性、用户存在性及目录权限。直到控制台输出 `PREFLIGHT OK`，方可进入下一步。

下一步：[安装核心服务](/zh/docs/production/core-services)。
