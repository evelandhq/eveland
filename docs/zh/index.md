---
title: 概览
description: 在企业自有基础设施上运行生产级 Agent 舰队。
---

企业运营的 Agent 数量终将超过员工人数。Eveland 就是为那个时代而生的基础设施。

今天，Eveland 为基于 [Eve](https://eve.dev) 框架构建的 Agent 提供自托管的生产基础设施：不可变发布、并行预览、流量灰度切分、宿主机沙箱隔离、可靠定时调度，以及端到端透明的会话追踪。

关于为什么要在自己的基础设施上运行 Agent，详见[为什么有 Eveland](/zh/docs/why)。

## Eveland 负责什么

```text
Eve 项目源码
  → 源码版本 (Revision)
  → 不可变发布 (Release)
  → 预览部署 (Preview Deployment)
  → 生产路由 (Stable Route)
  → 会话、用量与自动化 (Sessions, Usage & Schedules)
```

Eveland 不改变 Eve“文件即 Agent”的开发模式，也不接管应用自身的业务鉴权。当 Agent 代码编写完成、准备走向生产时，Eveland 负责接管后续的所有交付与运行生命周期。

## 生产级架构设计

在 Linux 生产环境中，Eveland 采用宿主机原生的轻量化拓扑：

- **核心管理服务**：API、Agent Gateway、Web 控制台与托管 OpenTelemetry Collector 负责调度与接入。
- **高密度运行时**：Worker 调度宿主机 systemd 与轻量沙箱（bubblewrap）运行 Agent 进程，提供毫秒级冷启动与无流量自动休眠（缩容到零）。
- **安全边界**：公开的 Agent 流量只经过网关，无法触碰宿主机控制器、源代码、解密后的密钥或底层数据库。

## 文档导航

- **评估与架构设计**：先读[为什么有 Eveland](/zh/docs/why)了解立项初衷，再查阅[设计决策](/zh/docs/reference/design)了解运行时密度、沙箱和缩容至零的权衡。
- **Agent 开发者**：若平台已就绪，直接上手[部署第一个 Agent](/zh/docs/agents/first-deployment)，接着了解[密钥与连接配置](/zh/docs/agents/secrets-connections)、[发布与灰度路由](/zh/docs/agents/releases-routing)。
- **平台管理员与 SRE**：从[生产架构概览](/zh/docs/production)开始，按步骤[准备宿主机](/zh/docs/production/prerequisites)并部署平台；日常运维请参考[运行时管理](/zh/docs/operations/runtime)、[健康诊断](/zh/docs/operations/diagnostics)与[故障排查](/zh/docs/reference/troubleshooting)。

_注：本地容器开发与代码贡献流程请参见代码仓库的 README。_
