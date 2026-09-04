---
title: 备份与恢复
description: 掌握平台控制面数据库、工作流数据库及持久化数据目录的备份策略与灾难恢复流程。
---

Eveland 本身不捆绑专有的备份工具，建议使用标准的开源工具（如 `pg_dump`、`rsync` 或云厂商的存储卷快照）。

为了实现一致性恢复，必须清晰了解**平台的状态由哪些部分组成**以及**恢复的正确顺序**。

---

## 1. 核心状态构成清单

进行完整备份时，以下三项必须保持在**同一时间点（同一快照窗口）**：

| 状态组件             | 存储介质与路径                            | 核心数据内容                                                                  |
| :------------------- | :---------------------------------------- | :---------------------------------------------------------------------------- |
| **控制平面数据库**   | PostgreSQL (`DATABASE_URL`)               | 项目配置、发布版本、部署历史、路由规则、团队账号与 AES-256 加密的密钥。       |
| **共享工作流数据库** | PostgreSQL (`EVELAND_WORKFLOW_WORLD_URL`) | 持久化工作流任务状态、定时器（Timer）与执行队列。                             |
| **持久化数据目录**   | 本地文件系统 (`/var/lib/eveland`)         | 源码快照、不可变发布包（`builds/`）、遥测配置及长效会话的 `/workspace` 目录。 |

_安全提示：所有加密存储的凭据均依赖宿主机的 `APP_SECRET_KEY`。请务必将该主密钥妥善备份至企业的外部密钥管理系统（KMS / Vault）中。_

---

## 2. 无需备份的临时内容

在做文件系统快照或备份同步时，可排除以下临时缓存：

- **npm 缓存目录**（`EVELAND_DATA_DIR/npm-cache/`）：可随时在线重新下载；
- **平台代码仓库与依赖**（`/opt/eveland` 及其 `node_modules`）：通过 Git Tag 与 `pnpm install --frozen-lockfile` 即可精准还原；
- **OTel Collector 待发队列**（`EVELAND_DATA_DIR/otel/`）：仅包含临时遥测缓冲。

_注意：`builds/` 下的不可变发布包**必须备份**。因为按需冷激活时 Worker 直接从磁盘加载发布产物；如果缺少发布产物，恢复后所有部署都必须重新触发打包。_

---

## 3. 标准灾难恢复流程

当遭遇硬件故障或灾难恢复时，请按以下顺序执行：

```bash
# 步骤 1：停止所有平台服务
sudo systemctl stop eveland-api eveland-gateway eveland-web eveland-worker eveland-workflow-dispatcher

# 步骤 2：恢复 PostgreSQL 数据库（控制面库与工作流库）
# 示例：通过 pg_restore 导入备份文件

# 步骤 3：在相同绝对路径（如 /var/lib/eveland）下恢复持久化数据目录

# 步骤 4：恢复 /opt/eveland 源码，检出备份时记录的精确 Release Tag
cd /opt/eveland
git checkout vX.Y.Z
pnpm install --frozen-lockfile

# 步骤 5：启动数据库与核心服务
sudo systemctl start eveland-api eveland-gateway eveland-web eveland-worker eveland-workflow-dispatcher

# 步骤 6：验证平台状态
# 登录控制台在 Settings → About 核对版本信息，发起测试请求验证按需唤醒
```

---

## 4. 宿主机非正常重启说明

普通的宿主机重启**无需执行备份恢复**：

- Agent 部署属于 systemd 瞬态服务（Transient Units），开机默认不自动拉起。
- 宿主机重启后，Worker 会自动启动并将失联的实例状态标记为休眠（`stopped`）。
- 当第一笔流量到达时，网关会自动冷启动对应版本，整个过程全自动完成。

## 相关参考

- [升级与回滚](/zh/docs/operations/upgrades)：版本迁移检查单与注意事项
- [容量规划](/zh/docs/operations/capacity)：数据根目录与发布包存储空间预算
- [安全模型](/zh/docs/operations/security)：主加密密钥 `APP_SECRET_KEY` 保护机制
