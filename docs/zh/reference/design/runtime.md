---
title: 为什么是 systemd 而不是 Docker
description: 生产环境用加固的 systemd 单元跑 Agent，因为机器资源应该服务 Agent，而不是基础设施。
---

## 决策

生产环境的 Eveland 把每个 Deployment 作为宿主机上加固的 systemd 瞬态单元
运行，由 root Worker 控制。Docker 是开发运行时（外加一个遗留安装的
opt-in profile），不是生产选择。

## 理由：密度

目标是把机器的性能压榨出来给 Agent。真实安装里 Agent 的数量很容易超过
使用它们的人数，所以经济账取决于一台机器能承载多少 Agent——基础设施
消耗的每一字节和每一个周期，都是 Agent 拿不到的容量。

Docker 收两遍税：守护进程常驻不走，且每个 Deployment 背着一个镜像，
即使什么都不运行，镜像层也占着磁盘。systemd 瞬态单元不运行时零成本，
Release 只是一个文件目录——没有镜像构建、没有层存储、没有按 Deployment
计的固定开销。配合[缩容到零](/zh/docs/reference/design/scale-to-zero)和
[bubblewrap 沙箱](/zh/docs/reference/design/sandbox)，多养一个**休眠**
Agent 的边际成本趋近于零，同样配置的机器在 systemd 上能跑的 Agent
严格多于容器方案。

决策当时记录的次级理由：

- **特权只存在于一个地方。** Worker 有意以 root 运行——它驱动
  `systemd-run`、`systemctl` 和属主交接——而每个部署的 Agent 都以各自的
  `DynamicUser` 无特权运行。除 Worker 外没有组件持有宿主机特权；API 和
  Agent Gateway 根本无法启动进程。
- **宿主机进程不需要网络管道。** 容器化的 Agent 要访问宿主机本地的模型
  服务（Ollama）需要注入一个 loopback 桥；宿主机进程直接绑 loopback 即
  可。systemd 适配器删掉了 Docker 适配器不得不打穿的一层。

## Docker 还负责什么

本地开发——`docker-compose.yml` 固定 `EVELAND_RUNTIME: docker`，macOS
开发不受影响——以及 macOS Appliance：`eveland-ctl` 在 Docker Desktop 上运行
整套栈，那里没有 systemd。Linux 生产只支持 systemd Runtime，不存在可切换的
Docker Agent Runtime。Linux Native 开发让 Collector 保持桥接，因为 Docker Runtime 会把它接入每个
Agent 的私有 Telemetry 网络。因此宿主机 API 在 Docker 私有 Bridge 地址上增加
第二个 Listener，只允许 Health、Collector Observation、Agent JWKS 与 Scheduler
Channel 路径；Control Plane 仍然只绑定 Loopback。生产环境的托管 OTel Collector
仍然容器化；Postgres 则彻底离开了 Compose——一个同时在三个网络命名空间里运行代码的
形态，对其中某一个命名空间内的数据库给不出统一地址。搬到宿主机上的是 _Agent_ 运行时。

## 混合运行时：可见，但不受支持

每个 Deployment 记录创建它的 `runtimeKind`，生命周期操作永远按这个记录
值解析适配器，而不是按 Worker 当前配置。记录下来的理由刻意收窄：这一列
的职责是"让混合状态可见、可停止，而不是让混合宿主机成为受支持的拓扑"。
停止一个当前宿主机上没有对应运行时的 Deployment 会作为记录在案的任务
失败大声报错，绝不静默。

## 构建去特权

构建步骤（`npm ci`、`npx eve build`）执行任意第三方生命周期脚本。威胁
模型里的对手是依赖树，不是项目作者，所以构建以专用的无特权 build 用户
在同一 bubblewrap 掩码内运行；root 只负责在 build 用户和 app 用户之间
编排属主交接。跳过沙箱（`EVELAND_BUILD_SANDBOX=none`）的开关存在，但
明确不推荐。

## 接受的代价

- 生产 Linux-only，且 Worker 以 root 运行。
- 资源限制是粗粒度的：一套全局内存/CPU 上限适用于所有 Deployment，而非
  按租户的预算。
- Secret 以 root 属主的 `0600` 环境文件送达 Agent，而不是 systemd 的
  `LoadCredential`，因为 Eve 应用从 `process.env` 读取——环境文件注入与
  `docker --env` 即插即用等价，不需要应用侧改动。
- 共享数据根 `/var/lib/eveland` 成为跨服务硬契约：API 容器必须以完全相同
  的绝对路径 Bind Mount 它，存储的源码路径才能对容器和宿主机 Worker 同时
  解析。

## 深入参考

- [生产架构概览](/zh/docs/production)：核心服务与宿主机 Worker 拓扑架构
- [安装宿主机 Worker](/zh/docs/production/worker)：systemd Service 安装与配置
- [为什么自研 bubblewrap 沙箱](/zh/docs/reference/design/sandbox)：构建与运行时沙箱隔离决策
- [缩容到零设计决策](/zh/docs/reference/design/scale-to-zero)：休眠 Agent 零成本与冷激活机制
