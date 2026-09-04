---
title: eveland-ctl 运维工具
description: 宿主机平台运维 CLI：安装脚本、appliance 目录布局、生命周期控制与环境体检命令。
---

`eveland-ctl` 是运行在平台宿主机上的管理与运维 CLI 工具，用于启停核心进程、体检系统环境、查看组件日志以及执行自动化升级。

---

## 1. 一键安装与脚本引导

在 Linux 宿主机上，可以通过官方安装脚本一键完成运行环境准备与代码拉取：

```bash
curl -fsSL https://eveland.ai/install.sh | bash
```

- **脚本行为**：自动检测宿主机操作系统与架构、探测或安装 Node.js 24、通过 Corepack 锁定 pnpm，并克隆最新稳定版本的 Eveland 代码至 `/opt/eveland`。
- **环境预备**：在 Ubuntu 等系统上，脚本会自动补齐 `git`、`curl` 以及 Docker/Compose 基础依赖，随后移交 `eveland-ctl start` 引导启动。

---

## 2. 宿主机 Appliance 目录布局

`EVELAND_HOME` 环境变量指定平台的运行主目录（Linux 默认为 `/opt/eveland`，macOS 默认为 `~/.eveland`）：

| 目录/文件路径      | 角色与存储内容                                                                  |
| :----------------- | :------------------------------------------------------------------------------ |
| `source/`          | 平台核心源码仓库（锁定在当前 Release Tag 上，升级时自动更新）。                 |
| `etc/eveland.env`  | 平台全局环境变量配置文件，所有服务的唯一配置真源。                              |
| `etc/install.json` | 记录平台安装模式元数据（如操作系统类型、外置或自带数据库标记）。                |
| `data/`            | 平台持久化数据根目录（即 `EVELAND_DATA_DIR`），存放源码快照、发布包及沙箱缓存。 |
| `logs/`            | 平台核心服务与安装过程的标准输出与错误日志。                                    |
| `backups/`         | 每次执行版本升级前自动生成的数据库快照备份。                                    |

---

## 3. 运维命令参考

| 命令                            | 核心行为与参数说明                                                                                                                          |
| :------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------ |
| `eveland-ctl start`             | 先启动依赖容器（OTel Collector、内置 Postgres），再拉起五个核心平台进程。支持 `--foreground`（前台运行）与 `--skip-infra`（跳过容器启动）。 |
| `eveland-ctl stop`              | 优雅停止平台服务（systemd 模式下按依赖逆序停止 unit），基础设施容器继续保持运行。                                                           |
| `eveland-ctl restart`           | 顺序执行 `stop` 与 `start`，平滑重启平台服务。                                                                                              |
| `eveland-ctl status`            | 综合检查进程存活状态、健康探针响应及基础设施容器连通性。全部正常退出码为 0。                                                                |
| `eveland-ctl logs [process]`    | 查看指定平台进程的实时日志。支持 `-f`（流式跟随）与 `--tail N`（显示尾部行数）。                                                            |
| `eveland-ctl doctor`            | 执行完整的宿主机环境深度体检（检查沙箱、端口占用、数据库连通性等），一次性汇总所有异常。                                                    |
| `eveland-ctl update`            | 自动备份数据库、拉取最新稳定版本、执行数据库迁移并滚动重启全部组件。支持通过 `--version vX.Y.Z` 指定目标版本。                              |
| `eveland-ctl install --systemd` | 为当前宿主机渲染并注册所有核心服务的 systemd unit 文件。                                                                                    |

---

## 4. 环境深度体检 (Doctor)

`eveland-ctl doctor` 命令对宿主机执行全方位健康巡检，核心检查项包括：

- **基础依赖**：Node.js、pnpm、Docker/Compose 以及 `unzip`、`bwrap` 工具链。
- **环境配置**：检查 `eveland.env` 必填项、生产环境禁用开发占位密钥（`eveland-dev-*`）。
- **端口安全**：核查 `17300` 等平台端口是否被外部进程冲突占用，确认数据库回环端口未被非法暴露至公网。
- **数据库一致性**：校验 `DATABASE_URL` 连通性，读取迁移账本确认当前架构处于最新状态。

## 相关参考

- [准备宿主机环境](/zh/docs/production/prerequisites)：基础工具链与沙箱环境配置
- [安装核心服务](/zh/docs/production/core-services)：systemd 核心服务配置指南
- [升级与回滚](/zh/docs/operations/upgrades)：版本迁移与维护流程
