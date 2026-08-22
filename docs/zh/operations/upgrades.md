---
title: 升级与回滚
description: 在明确 Migration、组件 Identity 与 Runtime Ownership 的前提下升级精确 Eveland Release。
---

将 Eveland Upgrade 视为协调一致的产品变更，而不是五个可部署组件（Dashboard、API、Agent Gateway、Worker 与 Workflow Dispatcher）各自重启。

各版本的专属升级步骤与兼容性说明见 [GitHub Release Note](https://github.com/evelandhq/eveland/releases)。开始前请阅读当前版本到目标版本之间每个 Release 的说明。

## 版本策略与 Release Channel

Eveland 使用 SemVer，从 `0.1.0` 开始：修复递增 Patch，特性递增 Minor，1.0 之前的破坏性变更同样递增 Minor 并附带明确的升级与回滚说明。Eveland 只支持最新的稳定 `0.x` Release；没有长期维护分支，也不向旧 Minor 回移修复。

每个组件报告同一份产品 Identity——`version`、`revision`、`channel` 与 `component`——出现在 Public `/health`（API、Agent Gateway）、启动日志与 **Settings → About** 中。`channel` 为 `dev`、`edge`、`prerelease` 或 `stable`：稳定安装运行精确的 `vX.Y.Z` Tag 并使用 `EVELAND_RELEASE_CHANNEL=stable`；测试 `main` 的实例使用 `edge` 和其精确 Revision。缺失值会有意变成 `unknown` 与 `dev`，而不是冒充稳定 Release。为每个组件设置相同的 `EVELAND_REVISION`（通常为 `git rev-parse --short=12 HEAD`）与 Channel。

GitHub Release 目前标识的是可复现的源码版本，而不是一组不可变容器镜像加 Worker 包：运维需要 Checkout Tag、安装 Frozen Lockfile、应用 Migration，并从同一 Revision 重启每个组件。不要把可变分支、`latest` 别名或部分重启的 Checkout 当作 Release 证据。

## 升级前

1. 阅读目标 GitHub Release Note 与兼容性变化。
2. 备份 Postgres、共享 Workflow 数据库与配置的数据根目录——见[备份与恢复](/zh/docs/operations/backup-restore)。
3. 确认每个组件报告当前精确 Revision。
4. 检查是否存在需要 Drain Deployment 的 Runtime Migration 或特别说明。

## 应用 Release

在核心服务 Checkout 中获取 Tag、Checkout 目标 Stable Tag、安装 Frozen Lockfile 并应用版本化的控制平面 Migration：

```bash
git fetch --tags origin
git checkout vX.Y.Z
pnpm install --frozen-lockfile
pnpm --filter @evelandhq/api db:migrate
```

对宿主机 Worker 自己的 Checkout（通常为 `/opt/eveland`）应用同一 Tag 与 Frozen Install。Worker 升级到此为止：Sandbox Backend（`@evelandhq/sandbox-bwrap`）由 Lockfile 固定、从 npm 预编译发布，没有单独的 Backend 构建步骤。共享 Workflow World 的 Schema Migration 也不是手动步骤——Worker 启动与 Tenant Provisioning 会自动应用所有待执行 Migration。

为五个组件设置相同的 Release Channel 与 Revision，再从该 Checkout 重启。只有 Public Health、Worker Startup Identity 与 **Settings → About** 全部一致后，升级才算完成。

## 回滚边界

只有旧版本仍兼容所有已应用 Migration 时，Checkout 旧 Tag 才安全。数据库 Migration 不会自动反向执行。必须遵循 Release 专属 Rollback Note，不能假设源码回滚已经足够。

不要通过切换 `EVELAND_RUNTIME` 规避升级步骤。已有 Deployment 保留其记录的 Runtime Owner；迁移宿主机 Runtime 前必须有意识地 Drain。

## 遗留的按 Project Workflow 残余

每个 Release 都基于共享、External-only Workflow World 构建，生产 Worker 缺少 `EVELAND_WORKFLOW_WORLD_URL` 时拒绝启动。带有共享 World 之前历史的安装可能仍保留遗留的按 Project Workflow 配置：

- 只在仍有遗留 Project 处于删除过程中时保留 `WORKFLOW_POSTGRES_URL`（与 `WORKFLOW_POSTGRES_BOOTSTRAP_URL`）——删除遗留 Project 时才会 Drop 其派生的 `eveland_wf_<project>_<digest>` 数据库。一旦没有任何保留 Deployment Attestation 为 Legacy World、且 `pg_database` 中除共享 World 本身外不再有 `eveland_wf_*` 数据库，即可取消这两个变量；遗留 Stream Retention Sweep（`EVELAND_WORKFLOW_SWEEP_*`）随之无事可做。孤立的 `eveland_wf_*` 数据库可用标准 Postgres 工具 Drop。External-only 安装永远不设置这些变量。
