---
title: 路由与 Deployment 生命周期契约
description: 详细规范：Host 模型、加权路由、SessionBinding、持久化 Operation 绑定、冷启动与孤儿进程回收。
---

本页规定了公开数据面与 Agent 部署生命周期的行为契约。

---

## 1. 域名与 Host 寻址模型

每个部署拥有不可变的 Release、专属预览域名（Preview Host）与运行时适配器（Runtime Adapter）：

- **生产稳定地址 (Stable Route)**：`http://<projectSlug>.<agentBaseDomain>`
- **专属预览地址 (Preview Host)**：`http://<deploymentKey>--<projectSlug>.<agentBaseDomain>`
- **标识符规范**：`deploymentKey` 为项目内唯一的 8 位小写字母数字串；完整 `dep_xxxxxxxxxx` 作为内部 ID。
- **证书复用**：预览域名的 `--` 分隔符保持在单级 DNS 标签内，单张通配符证书即可覆盖所有路由。

---

## 2. 预览、发布与加权路由 (Routing Policy)

- **原子切换 (Promote)**：构建与部署默认生成独立的 Preview 环境，点击 Promote 在网关层秒级更新生产路由，不重新构建发布包。
- **双目标加权分流**：一条路由最多支持两个目标版本，使用总和为 10,000 的基点（Basis Points）分配权重。
- **高可用自动降级**：当双目标策略中某一侧不可用（failed/starting/draining/stopped）时，网关会自动将未绑定会话的新请求路由至仅存的健康目标（即使其配置权重为 0），避免返回错误；仅在两侧均不可用时返回 503。

---

## 3. 会话亲和性 (SessionBinding)

当 Agent 返回 `sessionId` 后，网关持久化生成 `SessionBinding`：

- **亲和性锁定**：后续的继续（Continue）、取消（Cancel）及流式请求（Stream），即使经历 Promote、Rollback 或权重清零，**仍严格路由至最初绑定的 Deployment**。
- **过期策略**：Playground 绑定默认在空闲 24 小时后过期；公开 API 绑定默认在空闲 7 天后过期。每次请求刷新期限；请求已知但过期的绑定返回 `410 session_expired`。

---

## 4. 持久化路由与 Operation 绑定 (OperationBinding)

Eve 的持久化操作（create-once、task-input、MCP invocation）遵循固定目标规则：

- **首次写入胜出**：携带 `operationId` 的创建请求，网关使用独立密钥计算 HMAC 作为 operationKey，并以 `(projectId, operationKey)` 形式持久化首个处理目标，绝不在数据库中存储明文原始 ID。
- **MCP 任务跟踪**：MCP `agent_start` 成功返回的 `invocationId` 会被记录为绑定关系，后续针对该任务的 `agent_get`、`agent_update` 与 `agent_cancel` 自动回溯至原目标。
- **回调路径透传**：反向代理必须同时转发 `/eve/*` 与 `/.well-known/workflow/*`，确保工作流回调能够正常投递。

---

## 5. Deployment 生命周期状态机

部署生命周期依次经历以下状态：

$$\text{running} \longrightarrow \text{draining} \longrightarrow \text{stopped} \longrightarrow \text{archiving} \longrightarrow \text{archived}$$

- **保留保护规则**：最新构建的 N 个发布包、路由指向的目标、未过期的 SessionBinding 与活跃 ActivationLease 均受系统保留保护。
- **归档清理**：Worker 定期扫描停止且不受保护的旧部署，在数据库中原子置为 `archiving`，清理磁盘运行产物与构建目录后标记为 `archived`。

---

## 6. 按需激活与冷启动 (Scale-to-Zero)

- **租约机制**：公网请求、定时任务或工作流步骤在访问进程前获取 `ActivationLease`。
- **并发收敛**：若目标处于休眠，API 合并启动任务，由 Worker 冷启动对应版本。网关默认等待最多 30 秒冷启动。
- **空闲停止**：最后一个租约释放或超时后，Worker 等待配置的空闲等待时间（默认 5 分钟），确认无新租约后停止进程。

---

## 7. 端口预留与孤儿清理 (Orphan Sweep)

- **唯一端口预留**：激活启动前在数据库活跃状态实例表中先完成端口预留，确保同一端口至多只有一个活动实例。
- **孤儿清理**：Worker 周期性扫描宿主机上的 `eveland-*-dep_*` 进程。对于无 Deployment 记录、已归档或已删除的残留进程，在宽限期后执行强制停止。
- **失败诊断保留**：进程启动未通过健康检查时，Worker 在停止进程前自动捕获最近的 journal 日志与错误堆栈，脱敏后存入诊断记录。

## 相关参考

- [Release 与流量路由](/zh/docs/agents/releases-routing)：不可变 Preview、Stable 路由与会话绑定实操
- [Agent Gateway 数据面设计](/zh/docs/reference/design/gateway)：网关数据面规则与 Host 校验决策
- [缩容到零与冷激活](/zh/docs/reference/design/scale-to-zero)：ActivationLease 与空闲回收机制
- [健康与诊断](/zh/docs/operations/diagnostics)：Deployment 诊断数据采集与日志查看
