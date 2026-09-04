---
title: 升级与回滚
description: 标准平台升级步骤、备份要求、版本回滚原则与历史版本迁移说明。
---

Eveland 包含五个核心服务组件（API、Gateway、Dashboard、Worker 与 Workflow Dispatcher）。在执行平台升级时，应将其视为**协调一致的整体变更**，确保所有组件运行在相同的 Release 版本与 Git Revision 上。

各版本的具体兼容性说明与变更日志请查阅 [GitHub Releases](https://github.com/evelandhq/eveland/releases)。

---

## 0. 如何知道有新版本

`eveland-ctl status` 的第一行就是这台机器当前的版本；有更新时会直接说出来：

```
Release: v0.51.2 (stable) 6c1e3b8f2a91
  ! v0.52.0 is available (crosses BREAKING CHANGES in v0.52.0) — run `eveland-ctl update`
```

同样的提示也会出现在控制台的 **Settings → About**。

关于这个提示，有三点需要知道：

- **它问的是你自己的 git remote，不是 GitHub API。** 答案来自 `eveland-ctl update` 本来就要用的那个 remote 上的 `git fetch --tags`，因此 `status` 不可能给出与 `update` 相矛盾的结论；能升级的机器就一定能检查。
- **它从不阻塞。** 答案是一个缓存文件（`run/update-check.json`），由 `start` 之后、以及每天至多一次的 `status` 之后派生出的独立进程刷新。`status` 本身只读文件——它正是你在出问题时才会跑的命令。
- **它只做肯定判断。** 缓存可能是旧的，所以只在确实存在新版本时告诉你，其余情况一律沉默。`status` 永远不会声称"你已是最新"；这件事的权威是 `eveland-ctl update`，它会输出 `Already up to date`。

只有 `stable` 安装会参与比较。`edge` checkout 停在没有任何 release tag 指向的 commit 上，因此只显示 revision。

当磁盘上的 checkout 已经与运行中的平台脱节时，`status` 也会给出警告：

```
  ! The platform was started from b53ed56a1c22; the checkout is now 6c1e3b8f2a91.
```

这说明有人移动了源码树却没有执行 update，或者某次 update 在移动源码树与重启之间中断了。重新执行 `eveland-ctl update` 即可。

若不希望该检查访问网络，在 `etc/eveland.env` 中设置 `EVELAND_UPDATE_CHECK=off`。checkout 自身的身份仍会照常发布，因此上面的脱节警告与 About 页的版本显示都不受影响。

---

## 1. 升级前准备

1. **查阅目标版本 Release Notes**：确认是否存在需要特别注意的数据迁移或破坏性变更。
2. **执行数据备份**：备份控制面数据库、工作流数据库及数据目录（详见[备份与恢复](/zh/docs/operations/backup-restore)）。
3. **确认当前组件状态**：登录控制台在 **Settings → About** 中确认当前所有组件版本一致且状态健康。

---

## 2. 标准升级流程

### 用安装脚本装的（常规情况）

一条命令即可完成数据库备份、切换到最新版本、执行迁移并重启平台：

```bash
eveland-ctl update
```

用 `--version vX.Y.Z` 可以指定版本。在已安装的机器上重新执行 `curl -fsSL https://eveland.ai/install.sh | sudo bash` 效果相同——它会自动转交给 `eveland-ctl update`。

### 手工安装的

对于自行管理代码与 systemd 服务的环境，请按以下顺序执行。（想改由安装脚本接管，见[从旧版本迁移](/zh/docs/production/install#从旧版本迁移)。）

```bash
# 1. 检出目标稳定版本 Tag
cd /opt/eveland
git fetch --tags origin
git checkout vX.Y.Z

# 2. 安装锁定依赖并执行构建
pnpm install --frozen-lockfile
pnpm --filter @evelandhq/web build

# 3. 执行数据库迁移（必须在重启服务前完成）
pnpm --filter @evelandhq/api db:migrate

# 4. 重启平台核心服务
sudo systemctl restart eveland-api eveland-gateway eveland-web eveland-worker eveland-workflow-dispatcher
```

---

## 3. 升级后验收与验证

1. **版本一致性核对**：进入控制台 **Settings → About**，确认 API、Dashboard、Worker 与 Dispatcher 均已报告新的 `version` 与 `revision`。
2. **端到端测试**：在任意测试项目中触发一次 **Build & Deploy**，并通过 Playground 验证会话响应与流式输出是否正常。

---

## 4. 回滚原则与注意事项

- **代码与数据库版本对应**：只有在旧版本代码完全兼容当前已执行的数据库迁移时，回滚至旧 Git Tag 才是安全的。PostgreSQL 的 `db:migrate` 不会自动逆向回滚。
- **环境版本对齐**：回滚时必须同步回滚所有五个服务组件，严禁部分组件回滚而其他组件保持新版本。

---

## 5. 把工作流世界迁出平台数据库

在本次拆分之前配置的安装（`eveland-ctl` 此前把两个 DSN 都渲染到同一个库），其 `EVELAND_WORKFLOW_WORLD_URL` 指向的就是平台自己的库；`eveland-ctl doctor` 会以 `workflow-world-database` 报出来。这件事之所以要紧，是因为工作流库的 DSN 会注入到每一个 Agent Deployment：Agent 代码握着这份凭据，也就等于握着账号、会话与加密后的项目 Secret。

平台不会替你自动改指向：正在执行的 Run、Timer 与 Hook 都在当前库的 `workflow` schema 里，静默切换会把它们丢在原地。请停机后手工迁移：

```bash
eveland-ctl stop
createdb -h 127.0.0.1 -p 17310 -U eveland eveland_workflow
pg_dump -h 127.0.0.1 -p 17310 -U eveland -n workflow eveland \
  | psql -h 127.0.0.1 -p 17310 -U eveland eveland_workflow
```

随后把所有组件指向新库——`etc/eveland.env` 里的 `EVELAND_WORKFLOW_WORLD_URL`（以及设置过的 `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL`），手工 systemd 安装则是 `eveland-worker.env` 与 `eveland-workflow-dispatcher.env`——再启动。用 `eveland-ctl doctor` 复核；等一次部署和一次工作流执行都通过之后，再删掉旧 schema：

```sql
DROP SCHEMA workflow CASCADE;
DROP SCHEMA graphile_worker CASCADE;
```

已有 Deployment 在重建之前仍持有旧 DSN，所以迁移后请对每个 Agent 执行一次 **Build & Deploy**；在那之前它们的持久化 Run 仍写在旧库里。

---

## 6. 关键历史架构演进速查

如果你正从较早的历史版本进行跨大版本升级，请注意以下重要里程碑变化：

- **统一单一前门 (Origin 合并)**：平台将所有控制台与 Agent 流量统一收敛至 Agent Gateway（默认端口 `17300`），浏览器通过单一 `EVELAND_PUBLIC_ORIGIN` 访问，不再需要为前端单独烘焙 API 地址。
- **端口段统一规整**：平台各服务默认端口已全部迁移至专属端口段（如 API 为 `17301`，Gateway 为 `17300`，内置 Postgres 为 `17310`，Agent 动态端口为 `18000–18999`）。
- **Identity 路由规范**：身份认证与 Agent Catalog 端点统一迁入 `/api/` 命名空间（例如 `/api/identity/*` 与 `/api/agent-catalog`）。
- **外部工作流世界统一**：平台全面采用共享的 `@evelandhq/workflow-world` 架构，不再维护旧版按项目物理分库的模式。

## 相关参考

- [备份与恢复](/zh/docs/operations/backup-restore)：升级前后的完整数据备份与恢复操作
- [运行时与资源管理](/zh/docs/operations/runtime)：部署生命周期与工作流策略
- [配置参考](/zh/docs/reference/configuration)：各组件环境变量清单
