---
title: Workflow 架构设计决策
description: 为什么持久化工作流必须经由单例外置 Dispatcher 与自建的共享 Workflow World 运行。
---

## 1. 为什么必须采用外置调度器 (External Dispatcher)

持久化工作流（Durable Workflows）的核心职责，是确保在创建它的 Agent 进程被空闲回收停止后，未来的定时器与异步任务仍然能够准时触发。

内嵌的工作流运行器（In-process Runner）随着 Agent 进程一起生存，在[缩容到零](/zh/docs/reference/design/scale-to-zero)机制下会随进程一同休眠退出。因此，Eveland 强制采用外置模式（External Mode）：

- **职责解耦**：Deployment 自身严禁认领工作流任务；
- **单例保证**：全集群必须且仅由一个 [Workflow Dispatcher](/zh/docs/production/workflow-dispatcher) 实例负责从数据库拉取待执行任务，并在到期时通过内部激活端点唤醒目标 Agent，将执行步骤（Step）投递给 Agent；
- **排他互斥**：单实例通过 PostgreSQL Advisory Lock 严格保证，严禁启动多个副本，杜绝重复派发。

---

## 2. 为什么自研共享工作流世界 (`@evelandhq/workflow-world`)

在多项目企业级环境中，如果直接采用上游原生的工作流实现，会面临严重的跨租户串号风险：

1. **跨租户任务窃取的历史缺陷**：上游库基于固定的任务 ID 消费任务，导致任何一个存活的 Agent 都有可能意外认领走属于另一个 Agent 的排队任务，并使用自身的代码和环境变量错误执行。
2. **物理分库的沉重代价**：若为每个项目单独创建物理数据库，会导致数据库连接数爆炸、升级维护极度繁琐，且无法支持跨部署共享回调。
3. **正确解法：自研共享分区引擎**：
   Eveland 自主构建了 [`@evelandhq/workflow-world`](https://github.com/evelandhq/workflow-world)：
   - **调度归属收敛**：任务认领权限严格归属于外部 Dispatcher，Agent 进程本身无权认领，从架构层面彻底杜绝任务窃取；
   - **租户分区隔离**：以 `tenant_id`（项目 ID）作为强制逻辑分区，保证多项目共享同一数据库底座的同时实现严格数据隔离；
   - **发布无缝注入**：该引擎在 Release 构建期动态注入发布包中，无需业务代码做任何专有改造。

## 相关参考

- [安装 Workflow Dispatcher](/zh/docs/production/workflow-dispatcher)：宿主机 Dispatcher 安装与配置
- [运行时与资源管理](/zh/docs/operations/runtime)：Durable Workflow World 租户隔离与保留策略
- [定时任务与自动化](/zh/docs/observe/schedules)：面向开发者的定时任务与调度模型
