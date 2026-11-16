---
title: 健康检查与故障诊断
description: 掌握平台各层级健康检查机制、故障证据定位矩阵、沙箱自检，以及按现象排查常见故障。
---

Eveland 明确区分了**组件可用性 (Health)**、**异步任务日志 (Job Logs)**、**运行时标准输出 (Runtime Output)** 与 **会话追踪 (Session Events)**，帮助运维人员精准定位异常根因。

---

## 1. 组件健康检查与监控面板

- **公开探针**：API 与 Gateway 提供公开的 `/health` 接口，返回平台版本、Git Revision 与运行通道（Channel）。
- **心跳机制**：Worker 与 Workflow Dispatcher 持续向控制面发送心跳登记。
- **实例健康看板 (Settings → Instance health)**：
  - 展示宿主机 CPU、内存占用、磁盘使用率与增长趋势；
  - 监控当前排队与执行中的并发构建数（`Running builds N/cap`）；
  - 统计工作流死信（Dead Letter）与隔离任务积压情况。

---

## 2. 故障现象与排查证据定位矩阵

遇到异常时，请根据故障现象快速检索对应的日志入口：

| 故障现象                           | 首选排查入口                       | 核心定位方法                                                                                |
| :--------------------------------- | :--------------------------------- | :------------------------------------------------------------------------------------------ |
| **项目导入失败 / 预检报错**        | 控制台 Import Job 日志             | 检查 Git 仓库地址凭证、Zip 文件结构及依赖清单。                                             |
| **依赖安装失败 / 打包报错**        | 控制台 Build Log                   | 检查 `pnpm/npm` 依赖锁定、Eve 兼容版本及环境变量冲突。                                      |
| **部署实例启动失败 / 超时**        | Deployment 诊断信息与 systemd 日志 | 检查端口占用、环境配置文件权限及 `/eve/v1/health` 响应。                                    |
| **Agent 执行过程抛错 / 崩溃**      | 宿主机 systemd Journal 日志        | 检查 Agent 代码运行时堆栈与系统资源配额限制。                                               |
| **模型调用异常 / Token 未统计**    | 控制台 Sessions 会话历史           | 检查模型提供商 Key、OTel Collector 状态及网络连通性。                                       |
| **网关 502 / 域名解析失败**        | Gateway 反向代理日志               | 检查泛域名 DNS 记录、TLS 证书及目标 Deployment 是否处于健康状态。                           |
| **Workflow run 永远不结束**        | `eveland-ctl dead-letters`         | 修好死信指向的 Deployment，再 `--resolve` 重放它扣住的 run。                                |
| **宿主机崩溃后 dispatcher 不认领** | `eveland-ctl dispatcher-lock`      | 死会话可能还占着所有权锁；`--terminate` 踢掉后 `systemctl reset-failed` 再启动 dispatcher。 |

---

## 3. 读取指定部署的运行时日志

每个 Agent 部署在宿主机上均作为独立的 systemd 瞬态服务运行。使用以下命令实时跟踪其标准输出与错误日志：

```bash
# 查看指定部署的实时日志
sudo journalctl -u eveland-<projectSlug>-<deploymentId>.service -f
```

---

## 4. 构建日志中的沙箱自检 (Sandbox Self-check)

在构建阶段，Eveland 会自动向发布包注入轻量沙箱并在加固权限下执行即时自检：

- **自检通过标记**：
  ```text
  Sandbox self-check passed: the vendored bwrap provider runs under this host's deployment hardening.
  ```
- **如果自检失败（构建会自动中断退出）**，通常是宿主机先决条件未满足，请依次核查：
  1. `/etc/apparmor.d/bwrap` 配置文件是否存在并正确赋予了 `userns` 权限；
  2. 宿主机根目录是否存在 `/workspace` 挂载目录；
  3. 宿主机是否安装了完整的工具链（`bwrap`, `rg`, `grep` 等）。

---

## 5. 按故障现象排查

先在 **Settings → Instance health** 查看各组件状态，再按下面的现象定位。

### 5.1 Worker 服务无法启动

**常见原因**

- 宿主机缺少必要系统依赖（如 `bubblewrap`、`apparmor`、`bwrap` 用户命名空间权限）；
- 未创建 `/workspace` 挂载目录或 `eveland-app` / `eveland-build` 系统用户；
- `WORKFLOW_WORLD_URL` 环境变量缺失或无法连接 PostgreSQL。

**排查与解决**

1. 查看 Worker 服务日志：
   ```bash
   sudo journalctl -u eveland-worker -n 50 --no-pager
   ```
2. 运行宿主机检查，根据报告逐项修复：
   ```bash
   eveland-ctl doctor
   ```

### 5.2 项目一直处于 Pending 导入状态

**常见原因**

- Worker 进程未正常运行或已崩溃；
- Worker 与 API 访问的不是同一个数据库，或者两者读取的 `EVELAND_DATA_DIR` 路径不一致。

**排查与解决**

1. 检查 Worker 服务是否处于 `active (running)` 状态：
   ```bash
   sudo systemctl status eveland-worker
   ```
2. 确认 API 与 Worker 配置文件中的 `DATABASE_URL` 和 `EVELAND_DATA_DIR` 完全一致。

### 5.3 构建成功但健康检查 (Health) 超时

**常见原因**

- Agent 代码未正确监听分配的环境变量端口；
- Agent 代码启动发生异常或阻塞在初始化步骤；
- 沙箱自检（Sandbox Self-check）未通过。

**排查与解决**

1. 查看该 Deployment 的 systemd 运行日志：
   ```bash
   sudo journalctl -u eveland-<projectSlug>-<deploymentId>.service -n 100 --no-pager
   ```
2. 确认 `GET http://127.0.0.1:<port>/eve/v1/health` 返回 HTTP 200 且 body 为 `{ "ok": true }`。其他任何响应都会让 Deployment 无法就绪。404 通常说明作者的 `agent/channels/eve.ts` 用 `defineChannel(...)` 替换了 eve channel，从而丢掉了健康检查路由；改用 `eveChannel(...)` 即可保留。

### 5.4 公网域名返回 502 Bad Gateway 或冷启动超时

**常见原因**

- Agent Gateway 未启动或端口（`17300`）未正常监听；
- 反向代理（Traefik）错误拦截了请求；
- Agent 冷启动时间超过配置的超时上限（默认 30 秒）。

**排查与解决**

1. 检查网关服务状态与端口：
   ```bash
   sudo systemctl status eveland-gateway
   curl -I http://127.0.0.1:17300/health
   ```
2. 在控制台查看该 Deployment 的事件流，检查是否因依赖拉取过慢或模型预加载耗时过长导致冷启动超时。可通过增大 `EVELAND_COLD_START_TIMEOUT_MS` 放宽限制。

### 5.5 Token 消耗或会话事件缺失

**常见原因**

- 托管 OTel Collector 未启动或网络连接异常；
- 模型提供商未在响应流中返回用量（某个 Model Run 没有对应的 `usage.recorded`）。

**排查与解决**

1. 检查 Docker 内的 OTel Collector 容器日志：
   ```bash
   docker compose logs otel-collector
   ```
2. 在控制台 **Settings → Observability** 检查导出器连通性。Eveland 仅记录模型网关返回的真实 Token 数据，不主动估算缺失值。

### 5.6 定时任务 (Schedules) 未准时触发

**常见原因**

- Workflow Dispatcher 服务未启动或 Advisory Lock 获取失败；
- Cron 表达式不是标准的 5 段式分钟级 Cron（默认按 UTC 解读，定时任务设置了 IANA `timezone` 时按该时区解读）。

**排查与解决**

1. 检查 Dispatcher 服务状态与心跳：
   ```bash
   sudo systemctl status eveland-workflow-dispatcher
   sudo journalctl -u eveland-workflow-dispatcher -n 50 --no-pager
   ```
2. 进入项目的 **Sessions** 历史，查看对应的 **ScheduleRun** 详细条目，排查是否存在错过周期（Missed Ticks）或错误记录。

## 相关参考

- [运行时与资源管理](/zh/docs/operations/runtime)：进程生命周期与资源配额控制
- [沙箱架构设计](/zh/docs/reference/design/sandbox)：bubblewrap 沙箱加固与自检原理
