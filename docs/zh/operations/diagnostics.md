---
title: 健康检查与故障诊断
description: 掌握平台各层级健康检查机制、故障证据定位矩阵与沙箱自检排查。
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

| 故障现象                        | 首选排查入口                       | 核心定位方法                                                      |
| :------------------------------ | :--------------------------------- | :---------------------------------------------------------------- |
| **项目导入失败 / 预检报错**     | 控制台 Import Job 日志             | 检查 Git 仓库地址凭证、Zip 文件结构及依赖清单。                   |
| **依赖安装失败 / 打包报错**     | 控制台 Build Log                   | 检查 `pnpm/npm` 依赖锁定、Eve 兼容版本及环境变量冲突。            |
| **部署实例启动失败 / 超时**     | Deployment 诊断信息与 systemd 日志 | 检查端口占用、环境配置文件权限及 `/eve/v1/health` 响应。          |
| **Agent 执行过程抛错 / 崩溃**   | 宿主机 systemd Journal 日志        | 检查 Agent 代码运行时堆栈与系统资源配额限制。                     |
| **模型调用异常 / Token 未统计** | 控制台 Sessions 会话历史           | 检查模型提供商 Key、OTel Collector 状态及网络连通性。             |
| **网关 502 / 域名解析失败**     | Gateway 反向代理日志               | 检查泛域名 DNS 记录、TLS 证书及目标 Deployment 是否处于健康状态。 |

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
  Sandbox self-check passed: the vendored bwrap backend runs under this host's deployment hardening.
  ```
- **如果自检失败（构建会自动中断退出）**，通常是宿主机先决条件未满足，请依次核查：
  1. `/etc/apparmor.d/bwrap` 配置文件是否存在并正确赋予了 `userns` 权限；
  2. 宿主机根目录是否存在 `/workspace` 挂载目录；
  3. 宿主机是否安装了完整的工具链（`bwrap`, `rg`, `grep` 等）。

下一步：若遇到具体错误代码，请查阅 [故障排查速查手册](/zh/docs/reference/troubleshooting)。

## 相关参考

- [故障排查手册](/zh/docs/reference/troubleshooting)：按现象速查解决方案
- [运行时与资源管理](/zh/docs/operations/runtime)：进程生命周期与资源配额控制
- [沙箱架构设计](/zh/docs/reference/design/sandbox)：bubblewrap 沙箱加固与自检原理
