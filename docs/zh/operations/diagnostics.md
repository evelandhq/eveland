---
title: 健康与诊断
description: 在实际拥有故障的组件、Job、Runtime 或 Session Surface 中定位问题。
---

从真正失败的状态开始。Eveland 将组件 Health、异步 Job Log、Runtime Output 与 Session Event 分开，避免一条嘈杂日志成为唯一调试界面。

## 组件健康

- API 与 Agent Gateway Public `/health` 返回产品版本、Revision、Channel 与 Component。
- Worker 输出 Startup Identity，并写入已脱敏的 Configuration Snapshot。
- Built-in OTLP Receive Health 独立于核心服务 Health；Collector Exporter Queue 会分别重试。
- **Settings → About** 比较 Dashboard 与 API Identity，并向管理员显示 Allowlisted Masked Configuration。
- **Settings → Instance health** 使用持续 Worker Heartbeat、Agent Gateway Probe 与 Postgres 查询展示组件可用性，并显示 Worker 宿主机的 CPU、内存、数据文件系统和 Workload 趋势。旧的 Worker Configuration Snapshot 不能作为在线证据。

Instance Health 默认每分钟保留一份宿主机样本，并提供 24 小时与 7 天视图。磁盘增长至少有一天有效历史后才显示预计耗尽时间；历史不足时明确显示无法预测。整台服务器断电后无法自行上报，仍应由外部监控轮询 API 与 Agent Gateway 的 Public `/health`。

## 选择正确证据

| 故障                           | 首先检查                                                     |
| ------------------------------ | ------------------------------------------------------------ |
| Import 或 Source Validation    | Import Job 与 Source Preflight Log                           |
| 依赖安装或 `eve build`         | Build Log                                                    |
| Unit 启动或 Health Timeout     | Deploy Diagnostic 与 systemd Journal                         |
| Agent 进程输出                 | Runtime stdout/stderr                                        |
| Model、Tool、Subagent 或 Usage | Session Timeline                                             |
| Stable/Preview Host            | Agent Gateway Health、Route Policy 与 Target RuntimeInstance |

初始 Health Failure 会在清理前捕获有限长度的近期 Unit State 与 Journal。Project Secret 会被 Mask；Diagnostic 或 Cleanup Failure 不会覆盖原始 Deployment Error。

单个 systemd Deployment 的 Runtime Output 位于其 Transient Unit 的 Journal：

```bash
journalctl -u eveland-<project>-<deployment>.service
```

## Build Log 中的 Sandbox 证据

Release Preparation 向每个部署的 Eve 项目注入 bwrap Exec Sandbox，Build Log 总会说明发生了什么——绝不静默：

```
Injected eve sandbox modules: agent/sandbox.js
```

两种变体会替换或伴随这一行：

- 自带 Sandbox 定义的项目会记录 `Preserved the project's authored sandbox lifecycle (…)`——Eveland 只覆盖 `backend`，authored 的 `bootstrap()`、`onSession()`、`description`、`revalidationKey` 与 Workspace Seed 保持生效。
- 没有 `agent/` 目录的项目会记录 `Injected eve sandbox modules: none`，并 `WARNING` 提示部署后的 Agent 回退到 eve 默认 Sandbox 链。Build 不会因此失败。
- 声明了平台保留名称（`PATH`、`HOME`、`NPM_CONFIG_CACHE` 或运行时保留变量）的环境条目会以 `WARNING` 从 Build 中剔除。

**当 Sandbox 在真实运行时权限下不可用时，Build 会失败——这是有意为之。**Eve 惰性预热 Sandbox，所以坏掉的 bubblewrap 配置既不会让 `eve build`、`eve start` 失败，也不会让 `/eve/v1/health` 失败——该端点无论 Sandbox 状态如何都返回 `200`。Eveland 用 Build 后立即执行的运行时专属自检补上这个缺口：以真实的 Vendored Backend 在与部署完全一致的加固下运行（systemd 上是非特权用户 + `NoNewPrivileges` + `ProtectSystem=strict`；Docker 上是真实的 Capability/Seccomp 设置），用 Node 执行一个带类型的 `.ts` 文件，并验证包括真实 `rg` 与 GNU `grep` 搜索在内的每条平台命令。通过的 Build 会记录下列之一：

```
Sandbox self-check passed: the vendored bwrap backend runs under this host's deployment hardening.
Docker sandbox self-check passed: bwrap executed TypeScript with deployment-equivalent permissions.
```

自检失败会让 Build 本身失败。systemd 失败信息会点名需要修复的宿主机前提，并附上捕获的探针输出：

1. `/etc/apparmor.d/bwrap` 必须存在并授予 `userns`——Ubuntu 的 apt bubblewrap 不带 AppArmor Profile，`kernel.apparmor_restrict_unprivileged_userns=1` 会以 `setting up uid map: Permission denied` 阻止非 root bwrap。
2. `/workspace` 必须已作为空目录存在；bwrap 无法自己创建这个 Bind 目标。
3. 完整的平台 Sandbox 工具链必须在 `PATH` 上；Worker Preflight 一次性报告所有缺失命令。

Docker 失败会报告镜像探针输出，并要求确认本地引擎支持 `SYS_ADMIN`、`NET_ADMIN` 与 `seccomp=unconfined`。HTTP Health 通过并不代表 Sandbox 可用——这正是自检存在的原因。

继续使用[故障排查](/zh/docs/reference/troubleshooting)检查具体症状，包括 Scheduler、Cold Start 与 Activation 故障。
