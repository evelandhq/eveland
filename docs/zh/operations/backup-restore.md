---
title: 备份与恢复
description: 将控制平面数据库、共享 Workflow 数据库与数据根目录作为一组一致状态备份，并按正确顺序恢复。
---

Eveland 不自带备份工具。运维使用标准的 `pg_dump`、`rsync` 或文件系统/卷快照。Eveland 定义的是**状态是什么**，以及**哪些部分必须彼此一致**。

## 什么是状态

三个存储加配置承载恢复所需的一切：

1. **控制平面 Postgres**（`DATABASE_URL`）：Project、SourceRevision、Release、Deployment、Route、SessionBinding、ScheduleRun、Job、Team Membership，以及所有以 AES-256-GCM 密文存储的加密 Secret。
2. **共享 Workflow 数据库**（`EVELAND_WORKFLOW_WORLD_URL`）：持久化 Workflow Run、Timer、Stream 与 Per-run Queue。它是平台状态而非遥测——丢失它意味着丢失所有进行中与可恢复的持久化 Run。
3. **数据根目录**（`EVELAND_DATA_DIR`，通常为 `/var/lib/eveland`）：导入源码与上传、已构建的 Release Artifact、Deployment Env 文件、Agent Observability Policy、受管 Collector 配置与 Exporter Queue，以及 Sandbox Cache——它包含每个持久化 Session 的 `/workspace` 状态，虽名为 Cache，实为数据。
4. **数据库之外的配置**：平台环境文件（`/opt/eveland/etc/eveland.env`，或你的 `.env`）——`etc/` 下各服务的文件在每次启动时都从它重新渲染，无需单独备份。`APP_SECRET_KEY` 需要特别对待：数据库备份只含密文，没有 Key 的备份无法恢复任何已存 Secret。Key 材料应保存在 Secret Store 中，而不仅在宿主机上。

带有共享 World 之前历史的安装可能还持有派生的遗留 `eveland_wf_*` 数据库；在其 Project 被删除前它们同样是状态（见[升级与回滚](/zh/docs/operations/upgrades)）。

两个数据库与数据根目录必须来自同一时间点。控制平面行引用数据根目录中的路径（`sourcePath`、Release 目录），共享 World 的 Tenant 引用控制平面 Deployment；一侧领先另一侧的备份会让 Reconciliation 指向不存在的对象。请在静默窗口内备份（没有运行中的 Job 或 Build），或使用彼此一致的快照。

## 不需要备份的内容

- **npm 缓存**（数据根目录下的 `npm-cache/`）——按需重建。
- **Eveland Checkout 及其 `node_modules`**——可用 Release Tag 加 `pnpm install --frozen-lockfile` 复现。
- **Collector Exporter Queue**（数据根目录 `otel/` 之下）——排除它只丢失尚未投递的遥测，绝不丢失平台状态。

已构建的 Release Artifact（`builds/`）*不*可安全排除：Release 不可变，Cold Activation 启动的是磁盘上的精确 Artifact。排除 builds 意味着恢复后每个 Deployment 都需要重新 Build 并 Promote，历史 Release 溯源也随之丢失。除非接受这一代价，否则备份整个数据根目录、只排除 npm 缓存。

## 恢复顺序

1. 停止全部五个组件（Dashboard、API、Agent Gateway、Worker、Workflow Dispatcher），并保持公开 Ingress 关闭。
2. 从同一备份窗口恢复控制平面数据库与共享 Workflow 数据库。
3. 在**同一绝对路径**恢复数据根目录——API 的挂载路径与 Worker 的 `EVELAND_DATA_DIR` 必须一致，存储的 `sourcePath` 为绝对路径。
4. 恢复配置文件，Checkout 备份当时的精确 Release Tag 并安装 Frozen Lockfile。先恢复到相同版本，之后再走正常的[升级路径](/zh/docs/operations/upgrades)。
5. 启动 Postgres，再启动核心服务、Dispatcher 与 Worker。Worker 会把过期的 `ready` RuntimeInstance 对账为 `stopped` 或 `failed`；没有任何进程会自行重启。
6. 发送真实请求或等待 Schedule：下一次 Activation 会 Cold Start 保留的精确 Release。重新开放 Ingress 前，按 **Settings → About** 核对 Identity 与 Health。

## 宿主机重启恢复

重启不是恢复场景。systemd Deployment 进程是 Transient Unit，有意不在宿主机重启后自动拉起。已 Enable 的 Worker 服务会重启，把过期的 `ready` RuntimeInstance 对账为 `stopped`/`failed`；下一个 Cron 或 Agent Gateway 请求会 Cold Start 保留的精确 Release。不可变的 Deployment、Route、历史与 SessionBinding 全部保留；冷启动间隔内缺席的只有 Transient 进程。

## 深入参考

- [升级与回滚](/zh/docs/operations/upgrades)：版本升级检查单与控制平面数据库迁移
- [容量规划](/zh/docs/operations/capacity)：数据根目录、Release 产物与持久化 Workspace 存储预算
- [安全模型](/zh/docs/operations/security)：主加密密钥 `APP_SECRET_KEY` 保护与 Secret 恢复边界
