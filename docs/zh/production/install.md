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

这个脚本刻意做得很薄：补齐缺失的依赖（`git`、`curl`、Docker 与 Compose v2、Node 26——装在安装目录内的私有副本，不动你的 `PATH`），把最新稳定版本的代码克隆到 `/opt/eveland/source`，在 `/opt/eveland/bin` 放好 `eveland-ctl` 与 `eveland` 两个命令，然后把真正的安装工作交给 `eveland-ctl start`。

请以 root 身份运行：只有这样，首次启动才会直接落到生产形态——平台进程全部是 systemd unit，Docker 只保留 Collector 和可选的内置数据库。

## 2. 回答几个问题

首次启动只问那些必须由你决定的事：

| 问题             | 怎么填                                                         |
| :--------------- | :------------------------------------------------------------- |
| **公开访问地址** | 平台对外的 URL，例如 `https://console.example.com`。           |
| **管理员邮箱**   | 第一个管理员账号，密码由系统生成，不需要你输入。               |
| **数据库**       | 用内置的 Postgres 容器（单机足够），或填写你自己的集群连接串。 |
| **模型 API Key** | 可选。填了会预置一个内置示例 Agent，装完就有东西可以部署。     |

外部集群必须给平台会话级连接：不要在它前面放事务级连接池（例如事务模式的 PgBouncer），因为任务队列依赖 `LISTEN/NOTIFY` 和 Advisory Lock。安装程序会在同一台服务器上、平台库旁边创建共享 workflow 数据库。

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

## 延伸阅读

- [生产架构概览](/zh/docs/production)：五个核心服务各自负责什么，以及为什么跑在 systemd 上
- [eveland-ctl](/zh/docs/reference/ctl)：目录布局、完整命令参考与体检项
- [升级与回滚](/zh/docs/operations/upgrades)：如何安全地在版本之间移动
- [故障排查](/zh/docs/reference/troubleshooting)：按症状定位问题
