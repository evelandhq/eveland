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
- **来源溯源 (Provenance)**：每个 Deployment 都会显示其 Release 的源码来源：同步的提交，或是一次上传（来自 CLI 还是控制台、由谁发起、基于哪个提交、工作树是否有未提交改动）。向 Git 项目上传的版本默认以预览形式到达；无论是在本页面上 Promote，还是使用 `eveland deploy --promote`，都是一次明确的操作，并会让项目进入**热修复漂移**（见第 5 节）。

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

## 5. 热修复漂移 (Hotfix Drift)

Git 项目的生产环境可以运行一个上传的版本——从工作树以 `eveland deploy --promote` 发出的热修复，或在 Deployments 页面上 Promote 的预览上传。Eveland 允许这样做，但会让由此产生的状态可见，并守住退出它的路径。

- **定义**：当项目已发布 Deployment 的 Release 来自一个来源为上传（而非 `git-sync`）的 Source Revision 时，项目处于热修复漂移。该状态在每次读取时由这些记录推导得出，不做持久化；只有 Git 项目会漂移。
- **可见性**：项目的每个页面都会显示横幅——「生产环境正在运行一个上传的热修复（基于 `abc123`，含未提交改动，由 _用户_ 于 14:02 上传）；仓库中并不包含它。请在下次生产同步前将其提交。」——Deployments 列表显示每个 Deployment 的来源，部署日志记录了开启漂移的那次 Promote，`eveland deploy --promote` 在发布后也会打印同样的警告。`GET /api/projects/:id` 与 `GET /api/projects/:id/deployments` 以 `hotfixDrift` 字段返回它。
- **受保护的同步**：处于漂移时，Promote 一个来自 Git 的版本会替换掉热修复，因此 **Sync, deploy & promote**（以及当前版本是在热修复之后同步下来时的 **Build, deploy & promote**）会显示警告并要求明确确认；JSON API 会以 `400` 和 `code: "hotfix_drift"` 拒绝，除非请求体带有 `replaceHotfix: true`。预览同步不替换任何东西，也不需要确认。重新构建热修复本身，或用 `eveland deploy --promote` 再上传一个热修复，属于同类来源自我替换：无需确认，但 CLI 会打印被替换版本的来源。
- **解除**：一旦某个 `git-sync` 版本被 Promote——包括回滚——漂移即刻解除。Eveland 刻意不比较目录内容：把热修复提交进仓库并同步到生产，是用同样的代码结束漂移的唯一方式。

## 相关参考

- [路由与部署生命周期行为契约](/zh/docs/reference/routing)
- [网关流量设计与安全模型](/zh/docs/reference/design/gateway)
- [缩容到零与按需冷激活机制](/zh/docs/reference/design/scale-to-zero)
