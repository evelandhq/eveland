---
title: 为什么是 systemd 而不是 Docker
description: 生产环境采用 systemd 瞬态服务运行 Agent 的架构决策：让算力服务于 Agent 密度，而非基础设施开销。
---

## 核心决策

在 Linux 生产环境中，Eveland 将每个 Agent Deployment 作为宿主机上的加固 systemd 瞬态服务（Transient Unit）运行，由唯一的特权 Worker 统一编排。Docker 仅作为本地开发环境或非 Linux 平台的兜底方案，而非生产运行时的第一选择。

---

## 核心理由：极致的运行时密度

平台的核心目标是将宿主机性能最大化留给业务 Agent。在真实企业生产场景中，Agent 的数量将迅速超过团队员工人数。因此，单机的经济账完全取决于它能支撑多大的并发与休眠容量——基础设施自身消耗的每一兆内存与 CPU 周期，都在挤占可运行的 Agent 资源。

传统的容器化方案存在显著的资源冗余：

- **守护进程常驻开销**：Docker Daemon 与容器运行时常驻内存；
- **镜像层存储膨胀**：每个部署必须打包完整的 Docker 镜像层，即使实例休眠，磁盘空间依然被牢牢锁定；
- **冷启动链路过长**：容器的启动与网络栈初始化显著慢于宿主机原生进程。

相比之下，systemd 瞬态服务在不运行时**完全零开销**。Release 仅仅是一个普通的文件目录——没有繁重的镜像构建、没有分层镜像存储。配合[缩容到零](/zh/docs/reference/design/scale-to-zero)与[轻量 bubblewrap 沙箱](/zh/docs/reference/design/sandbox)，维护一个休眠 Agent 的边际成本趋近于零。相同规格的服务器，在 systemd 上能够承载的 Agent 数量数倍于传统容器方案。

---

## 权衡与安全隔离考量

1. **特权单点收敛**：Worker 以 root 身份启动，负责驱动 `systemd-run`、`systemctl` 与权限配置；每个被调度的 Agent 均运行在各自独立的临时 `DynamicUser` 下。除 Worker 外，API 与 Agent Gateway 无法直接启动宿主机进程。
2. **原生直连本地模型**：很多企业会在宿主机本地部署开源大模型（如 Ollama）。容器化 Agent 访问本机服务需要打通复杂的网络桥接；而在宿主机原生模式下，Agent 进程只需直接访问本地回环端口即可。
3. **构建去特权化**：执行第三方依赖脚本（`npm ci`、`npx eve build`）存在供应链安全隐患。因此代码构建强制在专用的非特权构建用户及 bubblewrap 沙箱中执行，杜绝依赖脚本提权危害宿主机。

---

## 接受的工程代价

- **Linux 宿主机绑定**：生产环境强依赖具备 systemd 的现代 Linux 发行版（推荐 Ubuntu 24.04 LTS）。
- **进程级粗粒度配额**：通过 cgroup 统一施加全局内存与 CPU 上限，而非细粒度虚拟化沙盒。
- **环境配置通过文件注入**：通过 root 拥有的 `0600` 权限环境文件传递 Secrets，避免命令行参数泄漏，与应用原生 `process.env` 读取方式平滑兼容。

## 相关参考

- [生产架构概览](/zh/docs/production)：核心服务与宿主机 Worker 拓扑架构
- [安装宿主机 Worker](/zh/docs/production/worker)：systemd Service 安装与配置
- [为什么自研 bubblewrap 沙箱](/zh/docs/reference/design/sandbox)：构建与运行时沙箱隔离决策
- [缩容到零设计决策](/zh/docs/reference/design/scale-to-zero)：休眠 Agent 零成本与冷激活机制
