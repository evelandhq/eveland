---
title: 路由与 Deployment 生命周期
description: Host 模型、流量权重与 Session/Operation 绑定、激活与端口归属、orphan sweep 的行为参考。
---

本页是公开数据面与 Deployment 生命周期的行为契约：地址模型、preview/promote 与加权路由、Session/Operation 绑定、冷激活与端口归属、orphan sweep。数据面不变量的决策理由见 [Agent Gateway](/zh/docs/reference/design/gateway)；缩容到零的理由见[缩容到零](/zh/docs/reference/design/scale-to-zero)；面向团队成员的叙事见 [Release 与路由](/zh/docs/agents/releases-routing)；进程生命周期的运维事实见 [Runtime 运维](/zh/docs/operations/runtime)。

## Host 模型

每个 Deployment 拥有不可变 Release、preview Host 和 runtime adapter，但不等同于一个永久在线进程。RuntimeInstance 记录某一代 Docker container 或 systemd unit，允许在 Deployment 仍可寻址、可 continuation、受 retention protection 时进入 `stopped`。Project stable Host 是可变路由；原始动态端口不是产品 URL，也不公开暴露。

开发环境中的 canonical 地址为 `http://<projectSlug>.agent.localhost:17300` 与 `http://<deploymentKey>--<projectSlug>.agent.localhost:17300`。Deployment 的公开 `deploymentKey` 是 Project 内唯一的 8 位小写字母数字 key；完整 `dep_xxxxxxxxxx` 仍作为内部 ID 使用。Preview 保持单层 hostname，以便生产环境的一个 `*.agents.example.com` wildcard certificate 覆盖 stable、preview 和 named alias。

## Preview、promote 与加权路由

底层 Build/deploy 默认创建并发运行的 preview，不停止 production Deployment，也不复用其端口。Dashboard 通过单一 `Create deployment` Dialog 组合 Source（当前 Revision 或先同步 Git）与结果（保留 preview 或健康后 promote）；任何选择 promote 的组合都必须显式 promote 该次任务创建的确切 Deployment，不能通过查询"最新 Deployment"猜测 target。

stable route 与 named alias 可原子地指向一个 100% target 或最多两个总计 10,000 basis points 的 weighted targets。新 Session 使用 deterministic affinity bucket；双 target policy 中一个 target 不可用（failed/starting/draining/stopped）时，Agent Gateway 必须把新 Session 降级路由到仅存的健康 target——即使其权重为 0——而不是对未 pinned 请求返回错误；两个 target 都不可用才返回 503。

## SessionBinding

Eve 返回 sessionId 后持久化 `SessionBinding`。continuation、cancel、stream 与 ID 寻址的 session reset 在 binding 未过期时，即使 promote、rollback 或 weight 归零也仍回到原 Deployment；每次成功使用前刷新 binding 的 `updatedAt`。Playground binding 默认 idle 24 小时过期，公开 API binding 默认 idle 7 天过期；已知但过期的 binding 必须返回 `410` 与稳定的 `session_expired` code，不能重跑路由权重或落到另一 Deployment。reset 成功后平台把对应平台 Session 标记完成；下一次新建 Session 重新按当前 route policy 选择 Deployment。

## Durable route 与 OperationBinding

Eve 的 durable route（create-once、task-input、MCP invocation）使用同一固定目标规则。initial create 携带非空 `operationId` 时，Agent Gateway 必须先以独立 Agent Gateway secret 做 HMAC，按 `(projectId, operationKey)` 首写胜出地持久化 `OperationBinding`，且不得保存或记录原始 operation ID；重复 create 即使遇到 promote、rollback、weight 归零或 dormant target 也回到首次目标。该绑定只决定 Deployment，不解释 Eve 基于 Agent principal 的幂等/授权语义；不同 principal 的同名 ID 最多共享目标，仍由 Agent 自己隔离结果。

Gateway 不为 Agent 失败伪造重试语义。initial Eve create 返回带 `errorId` 的 JSON 500 时，Gateway 原样转发 status 与 body，只增加保留的 `x-eveland-request-id` response header，并通过有界 clone 在平台遥测中关联 Project、Deployment、已激活 RuntimeInstance 与 HMAC operation key；原始 `operationId` 仍不落库、不进日志。typed retryable response 或已提交 run 的采纳属于 Eve 协议职责，Gateway 不能从通用 500 猜测异常类型。

MCP `agent_start` 成功后把 response `structuredContent.invocationId` 写为 SessionBinding，`agent_get`、`agent_update` 与 `agent_cancel` 按该 invocation ID 回到原 Deployment。`POST /eve/v1/task-input/:token` 的 token 对 Agent Gateway 完全 opaque，不得落库；同一 Project 的 Deployment 共享其 durable workflow world，因此 callback 可在 route targets 中任一窗口内的 Deployment 恢复，并通过正常 ActivationLease 唤醒 dormant target。当前窗口内的每条线都支持这些 durable route，不再维护按操作区分的版本下限；选定 target 不在支持窗口内时返回 409，不能降级成普通不持久的转发。

## Deployment 生命周期与归档

Deployment 生命周期为 running、draining、stopped、archiving、archived；最近三个 artifact、可变 route target、未过期 SessionBinding、未过期 OperationBinding 和活跃 ActivationLease 都受 retention protection。Worker 周期性扫描不受保护且已经 `stopped` 的旧 Deployment，幂等排入 archive job；archive 必须先原子地把目标置为 `archiving`（claim）——持有期间激活与 restart 都必须拒绝该 Deployment——claim 之后复查 retention protection，才按 Deployment 保存的 `runtimeKind` 删除 runtime artifact 和对应的 build directory，成功后置 `archived`，任何失败都回退到 claim 前的状态。构建或启动在 Deployment 落库前失败时也必须删除已准备的 build directory 和已创建的 runtime artifact，不能留下数据库无法寻址的 Release。

## 激活与冷启动

cron、public request、turn 和 stream 在访问进程前获取有期限的 ActivationLease。同一 dormant Deployment 的并发唤醒只允许一个 starter；API 只持久化/等待状态，不获得 Docker 或 systemd 权限，Worker 按 Deployment 保存的 `runtimeKind` 启动 exact Release。Agent Gateway 默认最多等待 30 秒冷启动，并保留 Agent 自有 auth、cookie、Host 语义、body limit、abort 和 NDJSON streaming。continuation 与 session reset 必须按 SessionBinding 唤醒原 Deployment，不能重新执行 route weighting。最后一个 lease 释放或过期后默认 idle 5 分钟再停进程；停机前必须事务式复查是否出现新 lease。Worker 启动后的 recovery 与 reconciliation 会重排中断的 activation job，并把实际已消失的 transient process 状态纠正为 stopped/failed。

在能识别 socket 归属的 runtime（systemd）上，就绪判定必须先确认 Deployment 端口上的监听 socket 属于它自己的进程：端口被其他进程持有时激活立刻失败，不得依据别的进程的 HTTP 响应把 Deployment 标记为 ready；reconciliation 对 ready RuntimeInstance 同样执行该归属核查，发现端口被外来进程持有即把实例与 Deployment 纠正为 failed，防止 Agent Gateway 继续把流量代理给错误的 Agent。

## 端口预留

监听端口是 RuntimeInstance 的属性：激活的 starter 在任何进程 bind 之前先把端口预留写入实例行，数据库以活跃状态（starting/ready/draining）上的唯一约束保证同一端口至多一个活实例；实例离开活跃状态即自动释放预留。systemd 唤醒优先收养仍被自己 unit 持有的上一代端口，收养不成则重新分配；Docker 的发布端口在容器创建时固定，预留失败必须大声失败而非换端口。`deployments.host_port` 从此是首次部署的偏好提示，不是权威端口——Agent Gateway 与内部激活路由以 activation 返回的 `endpointPort` 为准，仅在无激活数据时回退到 `host_port`。build_deploy 的端口分配发生在 build 之后、启动之前，并在 worker 进程内维持 in-flight 预留直到 Deployment 记录落库。

## Orphan sweep

Worker 按独立周期执行 orphan sweep，把主机上实际运行的 `eveland-*-dep_*` 进程与平台对账：持有活跃 lease 或 live RuntimeInstance 的进程不受影响；属于合法 Deployment 但失管的进程（早于 RuntimeInstance 机制部署、restart 后未激活等）仅当 Deployment 处于 running/draining 时被收养为 ready RuntimeInstance，从此由 idle 生命周期接管；没有 Deployment 记录、Deployment 已 archived/stopped/failed、或运行在非 Deployment 所属 runtimeKind 下的进程在宽限期后被停止——平台已决定停止的进程只能收割，不得复活。

清扫视野包含 systemd 处于 activating（auto-restart 翻滚中）的 unit；transient unit 配置显式 StartLimit，起不来的进程在限额后放弃而不是无限翻滚。清扫只匹配完整的 Deployment 命名形态，平台自身的 Compose 容器（`eveland-postgres-1` 等）永远不在清扫范围内。带平台 telemetry 标签但已无对应 Agent 容器的 Docker network 使用同一宽限期回收；回收前必须再次确认容器仍不存在，不能与并发启动竞争。

## 健康检查失败的诊断采集

新启动或重启的进程在 HTTP 健康检查失败时，worker 必须先采集 runtime diagnostics 再清理进程。Docker 记录容器 state、exit code、OOM/restart count 与最近 200 行 `docker logs`；systemd 记录 unit state、result/restart count 与最近 200 行 journal。诊断进入 Project runtime logs 前必须使用完整 Project Secret 集合脱敏并限制为 32,000 字符。诊断采集或后续清理失败只能追加独立错误，不能覆盖原始健康检查错误；响应和持久化日志不得泄露 Secret 明文。

## 深入参考

- [Release 与流量路由](/zh/docs/agents/releases-routing)：不可变 Preview、Stable 路由与会话绑定
- [Agent Gateway 不变量](/zh/docs/reference/design/gateway)：网关数据面规则与 Host 校验决策
- [缩容到零与冷激活](/zh/docs/reference/design/scale-to-zero)：ActivationLease、Idle 停止与生命周期管理
- [健康与诊断](/zh/docs/operations/diagnostics)：Deployment 诊断数据采集与日志查看
