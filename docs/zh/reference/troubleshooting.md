---
title: 故障排查手册
description: 常见生产部署、构建、网络路由、冷启动、定时任务与遥测故障的诊断与排查速查。
---

本手册按故障现象组织。排查前建议先在控制台 **Settings → Instance health** 查看基础服务的健康探针状态。

---

## 1. Worker 服务无法启动

### 常见原因

- 宿主机缺少必要系统依赖（如 `bubblewrap`、`apparmor`、`bwrap` 用户命名空间权限）；
- 未创建 `/workspace` 挂载目录或 `eveland-app` / `eveland-build` 系统用户；
- `EVELAND_WORKFLOW_WORLD_URL` 环境变量缺失或无法连接 PostgreSQL。

### 排查与解决步骤

1. 查看 Worker 服务日志：
   ```bash
   sudo journalctl -u eveland-worker -n 50 --no-pager
   ```
2. 运行自动化预检脚本，根据报错项逐一修复：
   ```bash
   pnpm --filter @evelandhq/worker exec tsx src/integration/preflight-check.ts
   ```

---

## 2. 项目一直处于 Pending 导入状态

### 常见原因

- Worker 进程未正常运行或已崩溃；
- Worker 与 API 访问的不是同一个数据库，或者两者读取的 `EVELAND_DATA_DIR` 路径不一致。

### 排查与解决步骤

1. 检查 Worker 服务是否处于 `active (running)` 状态：
   ```bash
   sudo systemctl status eveland-worker
   ```
2. 确认 API 与 Worker 配置文件中的 `DATABASE_URL` 和 `EVELAND_DATA_DIR` 完全一致。

---

## 3. 构建成功但健康检查 (Health) 超时

### 常见原因

- Agent 代码未正确监听分配的环境变量端口；
- Agent 代码启动发生异常或阻塞在初始化步骤；
- 沙箱自检（Sandbox Self-check）未通过。

### 排查与解决步骤

1. 查看该 Deployment 的 systemd 运行日志：
   ```bash
   sudo journalctl -u eveland-<projectSlug>-<deploymentId>.service -n 100 --no-pager
   ```
2. 确认 Agent 进程是否能正常响应 `GET http://127.0.0.1:<port>/eve/v1/health`。

---

## 4. 公网域名返回 502 Bad Gateway 或冷启动超时

### 常见原因

- Agent Gateway 未启动或端口（`17300`）未正常监听；
- 反向代理（Traefik）错误拦截了请求；
- Agent 冷启动时间超过配置的超时上限（默认 30 秒）。

### 排查与解决步骤

1. 检查网关服务状态与端口：
   ```bash
   sudo systemctl status eveland-gateway
   curl -I http://127.0.0.1:17300/health
   ```
2. 在控制台查看该 Deployment 的事件流，检查是否因依赖拉取过慢或模型预加载耗时过长导致冷启动超时。可通过增大 `EVELAND_COLD_START_TIMEOUT_MS` 放宽限制。

---

## 5. Token 消耗或会话事件缺失

### 常见原因

- 托管 OTel Collector 未启动或网络连接异常；
- 模型提供商未在响应流中返回 `step.completed.data.usage`。

### 排查与解决步骤

1. 检查 Docker 内的 OTel Collector 容器日志：
   ```bash
   docker compose logs otel-collector
   ```
2. 在控制台 **Settings → Observability** 检查导出器连通性。Eveland 仅记录模型网关返回的真实 Token 数据，不主动估算缺失值。

---

## 6. 定时任务 (Schedules) 未准时触发

### 常见原因

- Workflow Dispatcher 服务未启动或 Advisory Lock 获取失败；
- Cron 表达式使用了非标准的时区定义（平台仅支持标准的 5 段式 UTC Cron）。

### 排查与解决步骤

1. 检查 Dispatcher 服务状态与心跳：
   ```bash
   sudo systemctl status eveland-workflow-dispatcher
   sudo journalctl -u eveland-workflow-dispatcher -n 50 --no-pager
   ```
2. 进入项目的 **Sessions** 历史，查看对应的 **ScheduleRun** 详细条目，排查是否存在错过周期（Missed Ticks）或错误记录。

## 相关参考

- [健康与诊断](/zh/docs/operations/diagnostics)：系统可用性验证与排查矩阵
- [运行时与资源管理](/zh/docs/operations/runtime)：生命周期与孤儿进程回收
- [环境变量参考](/zh/docs/reference/environment-variables)：平台参数与超时配置
