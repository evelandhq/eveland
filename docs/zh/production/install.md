---
title: 安装 Eveland
description: 使用官方安装脚本与 eveland-ctl，一条命令完成 Eveland 生产环境安装。
---

一条命令即可安装 Eveland：它会准备宿主机、检出最新稳定版本、生成全部密钥、执行数据库迁移，并把平台交给 systemd 托管——机器重启后自动恢复。

## 开始之前

- **一台带 systemd 的 Linux 服务器**，且拥有 root 权限（我们以 Ubuntu 24.04 LTS 为准测试）。建议从 4 vCPU、8 GB 内存起步，容量规划见[资源规划](/zh/docs/operations/capacity)。
- **一个你能解析的域名**：控制台一个（如 `console.example.com`），Agent 一个泛域名（如 `*.agents.example.com`）。安装本身不需要 DNS，域名可以之后再配。

其余的一切——Node、pnpm、Docker、沙箱工具链、系统用户——都由安装脚本负责。

_macOS 也可以装，适合在本机试用：同样的命令去掉 `sudo`，会安装到 `~/.eveland`。生产环境请用 Linux。_

## 1. 执行安装

```bash
curl -fsSL https://eveland.ai/install.sh | sudo bash
```

想先看一眼脚本内容，可以下载下来、用官方校验和验证后再执行：

```bash
curl -fsSL https://eveland.ai/install.sh -O
curl -fsSL https://eveland.ai/install.sh.sha256 | sha256sum -c -
less install.sh && sudo bash install.sh
```

这个脚本刻意做得很薄：补齐缺失的依赖（`git`、`curl`、Docker 与 Compose v2、Node 24——装在安装目录内的私有副本，不动你的 `PATH`），把最新稳定版本的代码克隆到 `/opt/eveland/source`，在 `/opt/eveland/bin` 放好 `eveland-ctl` 与 `eveland` 两个命令，然后把真正的安装工作交给 `eveland-ctl start`。

请以 root 身份运行：只有这样，首次启动才会直接落到生产形态——平台进程全部是 systemd unit，Docker 只保留 Collector 和可选的内置数据库。

## 2. 回答几个问题

首次启动只问那些必须由你决定的事：

| 问题             | 怎么填                                                         |
| :--------------- | :------------------------------------------------------------- |
| **公开访问地址** | 平台对外的 URL，例如 `https://console.example.com`。           |
| **管理员邮箱**   | 第一个管理员账号，密码由系统生成，不需要你输入。               |
| **数据库**       | 用内置的 Postgres 容器（单机足够），或填写你自己的集群连接串。 |
| **模型 API Key** | 可选。填了会预置一个内置示例 Agent，装完就有东西可以部署。     |

其余配置都会自动生成并写入 `/opt/eveland/etc/eveland.env`（权限 `0600`）——认证密钥、服务间令牌，以及管理员密码：

```bash
sudo grep EVELAND_ADMIN_PASSWORD /opt/eveland/etc/eveland.env
```

之后就无需干预：脚本会准备宿主机（沙箱工具链、bwrap 的 AppArmor 配置、`/workspace`、`eveland-app` 与 `eveland-build` 用户），用 Docker 拉起 Collector 与内置数据库，执行迁移，构建控制台，最后注册并启动 systemd unit。当终端打印 `Eveland is running at …`，安装就完成了。

安装过程会询问是否把 `/opt/eveland/bin` 加入 `PATH`；不加也可以用全路径调用。

## 3. 确认装好了

```bash
eveland-ctl status    # 进程状态、健康检查、数据库连通性
eveland-ctl doctor    # 一次性列出健康宿主机所缺的一切
```

然后用管理员账号登录你的公开地址，继续：

- [配置 Agent 流量](/zh/docs/production/networking)——泛域名解析、TLS 证书与网关前面的反向代理。
- [验证安装](/zh/docs/production/verify)——用一个真实项目跑通端到端链路。

## 日常运维命令

| 命令                  | 作用                                                    |
| :-------------------- | :------------------------------------------------------ |
| `eveland-ctl status`  | 进程视图 + 实时健康与数据库探针，全部健康时退出码为 0。 |
| `eveland-ctl logs -f` | 实时跟踪平台进程日志。                                  |
| `eveland-ctl restart` | 停止并重新启动平台。                                    |
| `eveland-ctl doctor`  | 完整体检：工具链、配置、端口、数据库。                  |
| `eveland-ctl update`  | 备份数据库、升级到最新版本、执行迁移并重启。            |

在已安装 Eveland 的机器上重复执行安装脚本即为升级——它会自动转交给 `eveland-ctl update`。完整命令说明见 [eveland-ctl](/zh/docs/reference/ctl)。

## 从旧版本迁移

如果这台机器上已经跑着一套手工安装的 Eveland（自己 clone 的代码 + 自己写的 systemd unit），安装脚本可以就地接管它：数据库、发布产物、项目全部保留。能否成功只取决于一个值——**`APP_SECRET_KEY`**。数据库里所有项目密钥都用它加密，必须原样带过来；一旦重新生成，这些密钥就再也解不开了。

**1. 先备份两个数据库和数据目录**——见[备份与恢复](/zh/docs/operations/backup-restore)。这一步不要跳过。

**2. 停掉旧服务。**

```bash
sudo systemctl disable --now eveland-api eveland-gateway eveland-web eveland-worker eveland-workflow-dispatcher
```

**3. 把旧代码目录挪开。** 新的安装目录要占用 `/opt/eveland`，而你的旧检出多半就在那里：

```bash
sudo mv /opt/eveland /opt/eveland-old
```

**4. 安装，但先别启动。**

```bash
curl -fsSL https://eveland.ai/install.sh -o install.sh
sudo bash install.sh --no-start
```

**5. 把旧配置搬过去。** 将旧 `.env` 里的值写入 `/opt/eveland/etc/eveland.env`，保留脚本刚写进去的 `EVELAND_NODE` 那一行。至少需要这些：

```ini
EVELAND_PUBLIC_ORIGIN=https://console.example.com
EVELAND_AGENT_BASE_DOMAINS=agents.example.com
DATABASE_URL=postgres://…
EVELAND_WORKFLOW_WORLD_URL=postgres://…
EVELAND_DATA_DIR=/var/lib/eveland   # 继续指向原来的数据目录
EVELAND_RUNTIME=systemd
APP_SECRET_KEY=…                    # 必须是旧的那一个，否则已存密钥全部作废
BETTER_AUTH_SECRET=…                # 保留，否则所有人被登出
EVELAND_GATEWAY_SERVICE_TOKEN=…
EVELAND_GATEWAY_AFFINITY_SECRET=…
EVELAND_SCHEDULER_RUNTIME_SECRET=…
EVELAND_SCHEDULER_DISPATCH_SECRET=…
EVELAND_SCHEDULER_REDEEM_URL=http://127.0.0.1:17301/api/scheduler/redeem
WORKFLOW_DISPATCHER_ACTIVATION_API_URL=http://127.0.0.1:17301
WORKFLOW_DISPATCHER_ACTIVATION_TOKEN=…   # 与 EVELAND_GATEWAY_SERVICE_TOKEN 相同
EVELAND_OTLP_SERVICE_TOKEN=…
EVELAND_ADMIN_EMAIL=…
```

文件权限保持 `0600`。只要文件里已经有 `APP_SECRET_KEY`，首次启动就会原样采用这份配置：不再提问，也不会生成任何新密钥。

**6. 声明这套安装用的是哪个数据库**，写入 `/opt/eveland/etc/install.json`：

```json
{
  "version": 1,
  "installedAt": "2026-09-04T00:00:00Z",
  "method": "manual",
  "osMode": "linux",
  "bootstrapCompleted": false,
  "database": "external"
}
```

Postgres 是 `127.0.0.1:17310` 上的内置容器就填 `"bundled"`，是你自己的集群就填 `"external"`。没有这个文件时 ctl 拒绝猜测——猜错的结果是平台旁边多出一个空数据库。

**7. 启动并检查。**

```bash
sudo /opt/eveland/bin/eveland-ctl doctor   # 启动前先看缺哪些配置、端口和数据库是否就绪
sudo /opt/eveland/bin/eveland-ctl start    # 采用旧配置、安装 unit、执行迁移
/opt/eveland/bin/eveland-ctl status
```

`start` 会用自己管理的 unit 覆盖 `/etc/systemd/system/eveland-*.service`，并改从 `/opt/eveland/etc/` 读取环境变量，旧的 `/etc/eveland/*.env` 从此不再被读取。等到 **Settings → About** 里各组件版本一致、且一个已有项目能正常构建部署（这才真正证明 `APP_SECRET_KEY` 迁移成功），再删除 `/etc/eveland` 与 `/opt/eveland-old`。

此后升级就只是 `eveland-ctl update`。

## 如果你想手工安装

安装脚本是我们支持并持续测试的路径。只有当宿主机不允许时才建议手工安装——例如 `/opt` 没有 root 权限、镜像必须由配置管理工具生成、或每一步都要人工审核的加固环境。下面这条路径逐步做的，正是脚本自动完成的事：

[准备宿主机](/zh/docs/production/prerequisites) → [安装核心服务](/zh/docs/production/core-services) → [安装 Worker](/zh/docs/production/worker) → [安装 Workflow Dispatcher](/zh/docs/production/workflow-dispatcher) → [配置 Agent 流量](/zh/docs/production/networking) → [验证安装](/zh/docs/production/verify)。

## 延伸阅读

- [生产架构概览](/zh/docs/production)：五个核心服务各自负责什么，以及为什么跑在 systemd 上
- [eveland-ctl](/zh/docs/reference/ctl)：目录布局、完整命令参考与体检项
- [升级与回滚](/zh/docs/operations/upgrades)：如何安全地在版本之间移动
- [故障排查](/zh/docs/reference/troubleshooting)：按症状定位问题
