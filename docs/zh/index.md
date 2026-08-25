---
title: 概览
description: 在你掌控的基础设施上为 Agent 提供自托管生产级基础设施。
---

一家企业最终运营的 Agent 数量将超过员工人数。Eveland 就是为那个世界而生的基础设施。

今天，Eveland 从为 [Eve](https://eve.dev) Agents 提供自托管的生产级基础设施开始：为你的 Agent 舰队提供不可变 Release、并发 Preview、稳定流量路由、运行时隔离、持久化 Schedules 与透明的 Session 可观测性。立项论证——为什么要在自己的基础设施上运行 agent——见[为什么有 Eveland](/zh/docs/why)。

## Eveland 负责什么

```text
Eve Project
  → Source Revision
  → 不可变 Release
  → Preview Deployment
  → Stable Route
  → Sessions、Usage 与 Schedules
```

Eveland 不替代 Eve 的文件系统优先编写方式，也不接管 Agent 自己的应用认证。它管理的是项目准备好运行之后的部分。

## 为生产环境而设计

受支持的生产拓扑将核心服务与宿主机运行权限分开。Dashboard、API、Agent Gateway、Postgres 与托管 OpenTelemetry Collector 组成核心服务；宿主机 Worker 将 Eve Deployment 启动为隔离的 systemd Service，再由恰好一个 Workflow Dispatcher 补齐生产拓扑。Agent 端口只监听私有 Loopback，Agent Gateway 负责稳定与预览 Host。

该边界使 Docker Controller、源码、解密后的 Secrets 和 Telemetry Policy 数据远离公开 Agent 流量。每个 Deployment 的 CPU/内存限制、空闲停止与按需唤醒让资源使用保持可控。

## 选择你的路径

- **技术评估与架构师：** 阅读[为什么有 Eveland](/zh/docs/why)了解立项论证，并在[设计决策](/zh/docs/reference/design)中查阅运行时密度、bubblewrap 沙箱、缩容至零与网关设计的详细权衡。
- **Agent 开发者与团队成员：** 如果平台已就绪，直接从[部署第一个 Agent](/zh/docs/agents/first-deployment)开始，依次了解[密钥与 Connection](/zh/docs/agents/secrets-connections)、[Release 与流量路由](/zh/docs/agents/releases-routing)、[会话与用量追踪](/zh/docs/observe/sessions)以及[定时与自动化](/zh/docs/observe/schedules)。
- **平台管理员：** 从[生产架构](/zh/docs/production)开始，准备 Linux 宿主机，安装核心服务、宿主机 Worker 与 Workflow Dispatcher，最后完成链路验收。
- **平台运维与 SRE：** 使用[运行时与资源](/zh/docs/operations/runtime)、[健康与诊断](/zh/docs/operations/diagnostics)和[故障排查](/zh/docs/reference/troubleshooting)处理日常运营与排障；[容量规划](/zh/docs/operations/capacity)、[升级指南](/zh/docs/operations/upgrades)、[备份与恢复](/zh/docs/operations/backup-restore)与[环境变量参考](/zh/docs/reference/environment-variables)覆盖更深入的运维场景。

本地 Docker 开发和仓库贡献流程继续由仓库 README 承载，不属于生产部署主路径。
