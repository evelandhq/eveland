---
title: 配置参考
description: 查找生产配置分组以及每个值所属的组件。
---

以当前 Release 中的 `.env.example`、Production Compose Overlay 与 `infra/systemd/eveland-worker.env.example` 作为精确配置面。本页只整理 Ownership，不替代 Release 专属 Default。全部变量、默认值与读取位置见[环境变量](/zh/docs/reference/environment-variables)。

## 核心服务

配置 Public Origin、Better Auth、Team Bootstrap、Postgres、共享数据根目录、Application Encryption 与 Release Identity。只有 Dashboard 与 API 有意共享 Parent Domain 时才设置 Cookie Domain。

## Agent Gateway

配置 Agent Base Domain、Service Authentication、Affinity Signing、Private API Origin 与 Cold Start Timeout。Agent Gateway Service Secret 与 Affinity Secret 必须独立。

## Worker 与 Runtime

配置 `EVELAND_RUNTIME=systemd`、相同绝对数据根目录、Application Encryption、App/Build User、Build Sandbox、每 Deployment CPU/Memory、Retention 与 `EVELAND_WORKFLOW_WORLD_URL`。

## Workflow Dispatcher

配置共享 Workflow Database URL、Control API Activation Endpoint 与 Token、Pool Size、Concurrency 与维护节奏。以 `infra/systemd/eveland-workflow-dispatcher.env.example` 作为精确配置面；Dispatcher 以自己的 systemd Service 或容器运行，每个共享数据库单实例。

## Scheduler 与 Activation

配置独立 Runtime/Dispatch Secret、Private Redeem URL、Prewarm Duration、Activation Idle TTL 与 Recovery/Reconciliation Batch Control。

## Observability

部署时只配置文档要求的 OpenTelemetry 拓扑值。Agent Capture、隐私与外部目的地属于 System Settings；Telemetry Degradation 必须继续与 Agent Turn Success 分离。

不要将开发 Fallback 复制到生产。管理员可以在 **Settings → About** 比较 Allowlisted Effective Configuration；Secret Value 始终 Masked。

## 深入参考

- [环境变量参考](/zh/docs/reference/environment-variables)：平台全部环境变量名称、默认值与读取位置
- [生产架构概览](/zh/docs/production)：核心服务、宿主机 Worker 与 Dispatcher 的整体拓扑
- [安装核心服务](/zh/docs/production/core-services)：Compose 生产环境变量配置
- [安装宿主机 Worker](/zh/docs/production/worker)：Worker systemd 环境变量配置
- [安装 Workflow Dispatcher](/zh/docs/production/workflow-dispatcher)：Dispatcher 环境变量配置与参数调优
