---
title: 发布与流量路由
description: 深入理解不可变预览、生产路由、灰度加权分流、会话亲和性与版本保留策略。
---

Eveland 明确解耦了源码版本、构建发布包、部署实例与访问路由，使你可以在不影响线上生产的前提下自由验证新版本：

```text
项目 (Project)
  └─ 源码版本 (Source Revision)
       └─ 不可变发布包 (Release)
            └─ 运行部署 (Deployment)
                 ├─ 专属预览地址 (Immutable Preview Host)
                 └─ 生产与别名路由 (Mutable Stable / Alias Routes)
```

## 1. 独立预览与无感发布 (Preview & Promote)

- **不可变预览 (Preview)**：每次点击 **Build & Deploy** 都会打包一个全新且不可变的 Release，并在独立的沙箱环境中启动一个 Preview Deployment，拥有唯一的预览域名。
- **原子发布 (Promote)**：当验证通过后，点击 Promote 会在网关层秒级更新生产路由（Stable Route）的目标指向，**无需重新构建**。
- **秒级回滚 (Rollback)**：如果新版本上线后发现问题，可以随时将路由重新指向历史中保留的健康 Deployment，实现瞬时回滚。

## 2. 灰度发布与加权分流 (Weighted Routing)

生产路由（或自定义别名路由）支持配置灰度策略，实现平滑渐进式交付：

- **双目标切分**：路由可同时指定两个不同的部署目标，使用基点（Basis Points，总和为 10,000，即 100%）分配流量权重（如 `9000 : 1000` 表示 90% 对 10%）。
- **确定性会话分流**：新发起的根会话通过确定性哈希算法落入分流桶，确保分流比例严格符合配置。
- **高可用自动降级**：当配置了灰度切分的两个版本中有一个处于异常或启动中时，网关会自动将新请求调度至健康的单侧目标，避免对外抛错。

## 3. 会话亲和性与平滑下线 (Session Affinity & Draining)

对于多轮对话和长连接交互，流量切换必须保证用户体验的连贯性：

- **会话持久绑定 (SessionBinding)**：当 Agent 创建会话并返回 Session ID 后，Eveland 会将该会话与当前承接它的具体 Deployment 强绑定。
- **不受路由切换干扰**：后续的追加对话（Continue）、取消（Cancel）或流式监听（Stream），将**始终路由至原始绑定的 Deployment**，即便该版本已经被回滚、或者在新流量策略中权重已被设为 0。
- **平滑下线 (Draining)**：被替换的旧版本不会被立即暴力杀死，而是进入 Draining 状态，等待存量会话全部自然结束（或超时）后再安全停止。

## 4. 版本保留与自动归档 (Retention & Archiving)

为了兼顾历史追溯与宿主机磁盘空间，Eveland 提供了智能的生命周期保护：

- **受保护对象**：
  - 最近构建的 N 个最新 Release（由系统保留配置决定）；
  - 任何当前被生产路由或别名路由指向的目标；
  - 存在未过期会话绑定（SessionBinding）或活跃请求租约（ActivationLease）的部署。
- **自动归档清理**：当旧的 Deployment 停止运行且不再受上述规则保护时，后台 Worker 会自动回收其磁盘镜像产物与构建临时目录，防止磁盘膨胀。

## 相关参考

- [路由与部署生命周期行为契约](/zh/docs/reference/routing)
- [网关流量设计与安全模型](/zh/docs/reference/design/gateway)
- [缩容到零与按需冷激活机制](/zh/docs/reference/design/scale-to-zero)
