---
title: 验证平台
description: 用真实 Eve Deployment、稳定请求和已观察 Session 验证完整生产链路。
---

登录页可以打开并不能证明 Runtime 链路正常。使用有代表性的 Eve 项目验收完整系统。

## 平台检查

1. 确认 API 与 Agent Gateway `/health` 返回预期的稳定版本和精确 Revision。
2. 确认 Worker 已启动且生产 Preflight 通过（`journalctl -u eveland-worker`）。
3. 确认 Workflow Dispatcher 已打印 `workflow-dispatcher: ready` 且其 Registration 心跳保持新鲜——心跳过期时，生产构建与 Workflow Step 激活会以 `workflow_unavailable` 直接失败（Fail Closed）。
4. 以初始 Admin 登录，在 **Settings → About** 检查已脱敏的组件配置；所有组件必须在版本、Revision 与 Release Channel 上一致。
5. 邀请第二名团队成员，并确认 Invitation 只能使用一次。

## Runtime 检查

1. 导入依赖版本受支持的 Eve 项目。
2. 添加最少所需 Project Secrets。
3. 构建新的不可变 Preview。在构建日志中观察下述 Sandbox 标记。
4. 通过 Agent Gateway 调用 Preview Host，并完成一次真实 Turn。
5. 将健康 Deployment Promote 到 Stable Route。
6. 调用 Stable Host，确认 Session 带有 Deployment Provenance 与 Eve 报告的 Usage。
7. 等待 Idle Window 到期，再次调用并确认按需唤醒成功。

## 构建日志标记

systemd Runtime 上的健康构建会记录生成了哪些 Sandbox 模块，例如：

```
Injected eve sandbox modules: agent/sandbox.js
Sandbox self-check passed: the vendored bwrap backend runs under this host's deployment hardening.
```

Self-check 之所以存在，是因为 HTTP 健康检查通过并不代表 Sandbox 可用：Eve 惰性预热 Sandbox，损坏的 bubblewrap 环境否则要等到部署宣告成功很久之后、某次 Agent Turn 失败时才暴露。Eveland 改为在每次构建后立即以与部署等价的加固环境运行真实的 Vendored Backend，失败时**让构建本身失败**。失败信息会点名需要检查的宿主机前置条件（AppArmor Profile、`/workspace`、Sandbox 工具链）——参见[准备宿主机](/zh/docs/production/prerequisites)。

## Deployment 日志

每个 Deployment 作为 Transient Unit 运行；读取其 Journal：

```bash
journalctl -u eveland-<project>-<deployment>.service
```

Scheduler、Activation 与冷启动故障，从 **Settings → About** 与 Project Sessions 历史下的 ScheduleRun 详情开始排查——参见[故障排查](/zh/docs/reference/troubleshooting)。

## 集成冒烟测试（可选）

在确定生产宿主机模式之前，仓库的 Lima Harness 可在一台一次性 Ubuntu 24.04 VM 上端到端验证同一条 systemd/bwrap 链路：导入 Fixture 项目、在 bwrap 下构建、以 Transient Unit 启动、轮询健康、发起请求并拆除——外加 Scheduler Scale-to-zero 与 Managed Connections Fixture。

```bash
brew install lima
bash infra/integration/run.sh
```

完全成功的运行以 0 退出并打印 `SMOKE OK`。失败时从宿主侧检查 Guest Unit：`limactl shell eveland-test -- sudo journalctl -u 'eveland-*' --no-pager | tail -50`。

记录本次验收使用的精确 Revision 与配置。继续阅读面向团队成员的[部署第一个 Agent](/zh/docs/agents/first-deployment)。

## 深入参考

- [部署第一个 Agent](/zh/docs/agents/first-deployment)：面向 Agent 开发者的第一次部署指引
- [健康与诊断](/zh/docs/operations/diagnostics)：组件可用性验证与日志排查矩阵
- [故障排查](/zh/docs/reference/troubleshooting)：常见报错排查与已知限制说明
- [安全模型](/zh/docs/operations/security)：生产安装的完整安全边界与特权模型
