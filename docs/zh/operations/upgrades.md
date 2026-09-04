---
title: 升级与回滚
description: 标准平台升级步骤、备份要求、版本回滚原则与历史版本迁移说明。
---

Eveland 包含五个核心服务组件（API、Gateway、Dashboard、Worker 与 Workflow Dispatcher）。在执行平台升级时，应将其视为**协调一致的整体变更**，确保所有组件运行在相同的 Release 版本与 Git Revision 上。

各版本的具体兼容性说明与变更日志请查阅 [GitHub Releases](https://github.com/evelandhq/eveland/releases)。

---

## 1. 升级前准备

1. **查阅目标版本 Release Notes**：确认是否存在需要特别注意的数据迁移或破坏性变更。
2. **执行数据备份**：备份控制面数据库、工作流数据库及数据目录（详见[备份与恢复](/zh/docs/operations/backup-restore)）。
3. **确认当前组件状态**：登录控制台在 **Settings → About** 中确认当前所有组件版本一致且状态健康。

---

## 2. 标准升级流程

### 方式一：使用 `eveland-ctl` 管理的安装（推荐）

如果平台采用 `eveland-ctl` 部署管理，只需一条命令即可自动化完成拉取、迁移与滚动重启：

```bash
eveland-ctl update
```

### 方式二：手动部署的安装

对于手动管理代码与 systemd 服务的环境，请按以下顺序执行：

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

## 5. 关键历史架构演进速查

如果你正从较早的历史版本进行跨大版本升级，请注意以下重要里程碑变化：

- **统一单一前门 (Origin 合并)**：平台将所有控制台与 Agent 流量统一收敛至 Agent Gateway（默认端口 `17300`），浏览器通过单一 `EVELAND_PUBLIC_ORIGIN` 访问，不再需要为前端单独烘焙 API 地址。
- **端口段统一规整**：平台各服务默认端口已全部迁移至专属端口段（如 API 为 `17301`，Gateway 为 `17300`，内置 Postgres 为 `17310`，Agent 动态端口为 `18000–18999`）。
- **Identity 路由规范**：身份认证与 Agent Catalog 端点统一迁入 `/api/` 命名空间（例如 `/api/identity/*` 与 `/api/agent-catalog`）。
- **外部工作流世界统一**：平台全面采用共享的 `@evelandhq/workflow-world` 架构，不再维护旧版按项目物理分库的模式。

## 相关参考

- [备份与恢复](/zh/docs/operations/backup-restore)：升级前后的完整数据备份与恢复操作
- [运行时与资源管理](/zh/docs/operations/runtime)：部署生命周期与工作流策略
- [配置参考](/zh/docs/reference/configuration)：各组件环境变量清单
