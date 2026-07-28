---
title: Release 与流量
description: 理解不可变 Preview、Stable Route、加权 Target、Session Affinity 与 Retention。
---

Eveland 将编写的源码、构建产物、Route Identity 与运行进程分开，使新 Release 可以在生产版本旁测试。

```text
Project
  └─ Source Revision
       └─ Release
            └─ Deployment
                 ├─ 不可变 Preview Host
                 └─ 可变 Stable / Alias Route
```

## Preview 与 Promote

每次成功 Build & Deploy 都创建新的 Release 与并发 Preview Deployment。Promote 更新 Route，不重建或修改 Release。Rollback 选择另一个保留中的健康 Deployment，并将 Route 移回。

## 加权流量

可变 Route 可以选择一个 Target，或最多两个权重合计 10,000 Basis Point 的 Target。新 Root Session 使用确定性 Affinity。每次双 Target Policy Revision 都产生独立 Experiment Identity。

## Session Affinity

Eve 返回 Session ID 后，Eveland 持久化它与所属 Deployment 的 Binding。即使发生 Promote、Rollback 或权重降为零，Continue、Cancel 与 Stream 仍回到原 Target。因此 Deployment 离开新流量后可能继续 Draining。

## Retention

Eveland 至少保护配置数量的最新 Release。可变 Route Target、未过期 SessionBinding、活跃请求 Lease 或其他生命周期保护可以让更旧 Release 不受年龄影响地保留。Playground binding 默认 idle 24 小时过期，公开 API binding 默认 idle 7 天过期；每次成功使用都会刷新期限。请求已知但过期的 binding 会收到 `410 session_expired`，不会被路由到其他 Deployment。旧 Deployment 的 RuntimeInstance 停止且不再受保护后，Worker 会自动归档并删除 runtime artifact 与 build directory；Deployment 落库前失败的构建会立即清理。
