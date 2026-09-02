---
title: 生产架构
description: 理解受支持的核心服务、宿主机 Worker、Workflow Dispatcher、Agent Gateway 与 systemd Runtime 拓扑。
---

Eveland 的生产边界刻意不同于本地开发栈。生产 Eve Deployment 不通过开发阶段的 Docker Runtime 运行：它们作为非特权 systemd Unit 直接运行在宿主机上，由唯一的特权 Worker 控制。

![Eveland 生产拓扑](../../assets/topology-zh.svg)

## 核心服务

Dashboard、API、Agent Gateway、Postgres 与托管 OpenTelemetry Collector 通过生产 Compose Overlay 运行。API 负责需要团队认证的操作和持久化。Agent Gateway 是唯一公开的 Agent 数据面，既不持有 Docker Socket，也不能访问 Source、Release、Secrets 或 Collector 配置；Compose 栈对它屏蔽了数据目录。Overlay 既不启动 Worker 也不启动 Workflow Dispatcher：两者都是宿主机 unit，见下一节与[安装 Workflow Dispatcher](/zh/docs/production/workflow-dispatcher)。

## 宿主机运行控制器

Worker 作为 root 管理的 systemd Service 直接运行在 Linux 宿主机上，是唯一可以构建不受信任项目代码并控制 systemd Unit（`systemd-run`、`systemctl`、`chown`）的组件。构建在 bubblewrap Sandbox 内以独立的非特权构建用户运行；每个 Eve Deployment 使用自己的 systemd `DynamicUser`，只监听私有 `127.0.0.1:41xxx` 端口。Worker 没有公开监听端口。

## Workflow Dispatcher

Durable Workflow 以 External 模式运行：Deployment 从不认领自己的 Timer。恰好一个 Workflow Dispatcher 与 Worker 并行运行，从共享 Workflow 数据库认领 Durable Workflow Job，并把每个 Step POST 回所属 Deployment——若该 Deployment 已被空闲回收则先唤醒它。没有这个进程，Durable Timer、唤醒与 Continuation 永远不会触发。参见[安装 Workflow Dispatcher](/zh/docs/production/workflow-dispatcher)。

## 共享数据契约

API 与 Worker 必须看到相同的绝对数据根目录，通常为 `/var/lib/eveland`；API 容器以完全相同的宿主机路径 Bind Mount 它。Project 存储的 `sourcePath` 由导入 Project 的一侧写入，由之后提供服务或部署的一侧读取，因此挂载不一致会让一侧找不到另一侧写入的文件。导入源码、Prepared Release、Agent Observability Policy、托管 Collector 配置与 Sandbox Cache 全部位于该数据根之下。

## 遥测拓扑

托管 Collector 在宿主机 Loopback 端口 17311/17312 发布经 Service Authentication 保护的平台 Receiver，在 17313/17314 发布 Agent Receiver。systemd Agent 访问宿主机 Loopback 端口 17314；每个活跃的 Docker Deployment 则获得一个只包含其 Agent 与 Collector 的私有网络。任何一个 Receiver 都绝不能发布到公开接口。

Agent Receiver 不做认证，因此每个 Deployment 的遥测由写入其只读 `agent-policy.json` 的 Worker 签名凭证归属；平台校验该凭证并用 Store 持有的 Deployment 身份替换 Agent 自报的归属。不同 Agent Deployment 无法通过遥测路径相互解析或连接。Collector 缺失只会降级遥测，绝不会阻塞 Agent 启动或冷激活；修改可观测性设置只重启 Collector，从不重启 Agent Deployment。

## 公开入口

一切流量都经由 TLS 反向代理进入宿主机端口 `17300` 上的 Agent Gateway 前门：平台 Host（`EVELAND_PUBLIC_ORIGIN`）上是 Dashboard 与浏览器 API，Wildcard Agent Host 上是 Agent 流量。Deployment 端口始终留在 Loopback。参见[配置 Agent 流量](/zh/docs/production/networking)。

## 资源生命周期

持久化 Deployment 不等于永久运行的进程。流量、Continuation 或 Schedule 通过 Activation Lease 唤醒精确 Release。最后一个 Lease 结束后，Worker 在配置的空闲时间后停止 RuntimeInstance，同时保留 Deployment、Preview 地址与 SessionBinding。

systemd Deployment 进程是 Transient Unit，宿主机重启后不会自动恢复。已启用的 Worker 会随宿主机重启，回收过期的 RuntimeInstance；下一次请求或 Schedule 会冷启动保留的精确 Release，冷启动间隙缺失的只有那个瞬态进程。

继续[准备宿主机](/zh/docs/production/prerequisites)。
