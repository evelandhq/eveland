---
title: 安装 Workflow Dispatcher
description: 安装单例外置 Workflow Dispatcher，负责持久化工作流的定时器触发、按需唤醒与断点续传。
---

> **手工安装路径。** 本页所有步骤，[安装脚本](/zh/docs/production/install)都会自动完成。只有在必须手工安装时才需要照做。

在生产环境中，Eveland 的持久化工作流（Durable Workflows）必须以外置模式（External Mode）运行。Agent 部署本身不自行认领工作流任务；每个平台安装中**必须且仅能运行一个 Workflow Dispatcher 实例**，负责从数据库认领任务并按需唤醒对应 Agent 执行后续步骤。

## 1. 核心职责与工作机制

- **任务认领与激活**：Dispatcher 从共享工作流数据库中拉取到期的 Timer 和任务步骤（Step），通过内部 Control API 激活休眠的目标 Agent（若已被空闲停止），并将任务投递给 Agent。
- **单实例互斥保护**：Dispatcher 在生命周期内持有 PostgreSQL Advisory Lock，全集群自动互斥，严禁启动多个副本。重启具有幂等性，不会丢失排队中的任务。
- **零租户代码触碰**：Dispatcher 仅与数据库和本地 HTTP 接口通信，运行在独立的非特权用户（`DynamicUser`）下，不读取任何 Agent 业务代码或私有密钥。

## 2. 安装与启动 systemd 服务

Dispatcher 与 Worker 共用 `/opt/eveland` 代码库：

```bash
sudo install -d -m 0750 /etc/eveland
sudo cp infra/systemd/eveland-workflow-dispatcher.env.example /etc/eveland/eveland-workflow-dispatcher.env
sudo cp infra/systemd/eveland-workflow-dispatcher.service /etc/systemd/system/
```

编辑配置文件后，重载 systemd 并启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eveland-workflow-dispatcher
```

## 3. 核心环境变量配置

在 `/etc/eveland/eveland-workflow-dispatcher.env` 中，确保以下值与平台核心服务保持一致：

```ini
# 共享工作流数据库（必须与 Worker 注入的值完全一致）
EVELAND_WORKFLOW_WORLD_URL=postgres://eveland:password@127.0.0.1:17310/eveland

# 内部激活 Control API 地址与凭证（用于冷启动休眠的 Agent）
WORKFLOW_DISPATCHER_ACTIVATION_API_URL=http://127.0.0.1:17301
WORKFLOW_DISPATCHER_ACTIVATION_TOKEN=your_api_service_token

# 调度安全凭据（必须与 Worker 一致）
EVELAND_SCHEDULER_RUNTIME_SECRET=your_scheduler_runtime_secret

# 遥测与版本标记
EVELAND_OTLP_ENDPOINT=http://127.0.0.1:17311
EVELAND_OTLP_SERVICE_TOKEN=your_otlp_service_token
NODE_ENV=production
EVELAND_RELEASE_CHANNEL=stable
EVELAND_REVISION=your_git_commit_sha
```

_注意：`WORKFLOW_DISPATCHER_LEASE_RENEW_INTERVAL_MS` 必须明显低于 API 的 `EVELAND_ACTIVATION_LEASE_TTL_MS`，避免长耗时任务在执行中途因租约失效被回收。_

## 4. 验证运行状态与心跳机制

启动后查看服务运行日志：

```bash
sudo journalctl -u eveland-workflow-dispatcher -f
```

- 正常就绪时，日志会输出 `workflow-dispatcher: ready`。
- Dispatcher 会通过服务间认证持续向控制面 API 发送心跳登记（Registration）。
- 登录控制台，在 **Settings → Instance health** 中确认 Workflow Dispatcher 状态显示为健康活跃。

下一步：[配置 Agent 流量与反向代理](/zh/docs/production/networking)。

## 相关参考

- [Workflow 架构设计决策](/zh/docs/reference/design/workflow)：外置调度器与自建共享 Workflow World 设计权衡
- [运行时与资源管理](/zh/docs/operations/runtime)：工作流租户隔离、生命周期与存储策略
- [配置参考](/zh/docs/reference/configuration)：Dispatcher 完整调优参数与并发设置
