---
title: Workflow 架构
description: 为什么持久 workflow 经由唯一的外置 dispatcher 和自建的共享 Workflow World 运行。
---

## 为什么是外置 dispatcher

持久 workflow 是必须在创建它的进程被空闲回收*之后*仍能触发的计时器与
continuation。内嵌的 workflow runner 活在 Agent 进程里，在
[缩容到零](/zh/docs/reference/design/scale-to-zero)之下随进程一起消失。
因此 Eveland 只以外置模式运行 workflow：Deployment 绝不认领自己的
workflow 任务；每个安装恰好一个 Workflow Dispatcher 从 Postgres 认领
工作，通过 Agent Gateway 冷启动所用的同一个内部端点激活所属
Deployment，再把 step POST 回去。

- 内嵌模式不只是默认关闭——配置它是一个启动错误，没有静默回退。
- "恰好一个"由终生持有的 Postgres advisory lock 强制；第二个 dispatcher
  fail closed。重启很便宜，因为每个认领都在 Postgres 里。
- dispatcher 绝不加载租户代码、绝不触碰 Deployment 文件：只连 Postgres
  和 loopback HTTP，无特权，跑在自己的 `DynamicUser` 下。
- dispatcher 缺失或过期会让共享构建和 `workflow_step` 激活
  **fail closed**（`workflow_unavailable`）——静默永不触发的持久工作，
  比一个可见的 503 更糟。

## 为什么自建 Workflow World

上游 `@workflow/world-postgres` 通过固定的 graphile-worker task id 消费
工作。在多 Project 安装里这有一个具体后果，曾在生产中表现为间歇性的
"model provider could not load an API key"失败：**任何在跑的 Eve runtime
都能认领任何 Project 排队中的 turn，并用自己的代码和 Secret 执行它。**
队列命名空间救不了——它只改 topic 前缀，不改被认领的 task id——而上游的
启动恢复还会不加过滤地重新入队所有 Project 的活跃 run。

历史有三个阶段，顺序很重要：

1. **一个共享的上游数据库**——产生了上述跨 Project turn 窃取。
2. **每个 Project 一个物理数据库**——修好了隔离，代价是基础角色要
   `CREATEDB`、每条启动路径都背上派生数据库生命周期、删除失败时泄漏
   孤儿数据库。而当 Eve 0.37 加入持久 task-input callback 时它彻底不够
   用了：callback token 对 Gateway 不透明，同一 Project 的*所有*
   Deployment 必须看到同一批持久钩子——按代际分库给不了这一点。
3. **做对了的共享数据库**——
   [`@evelandhq/workflow-world`](https://github.com/evelandhq/workflow-world)：
   认领只属于外置 dispatcher（Agent 什么都认领不了，从结构上关死 turn
   窃取的门），tenant 是强制列并按 Project 分区，恢复按 tenant 过滤。
   同一 Project 的 Deployment 有意共享一个 world；Project 之间保持隔离。

world 以已发布的 npm 包被消费，并在构建时注入不可变的 Release——绝不
patch `node_modules`，绝不要求 Agent 源码声明。Eve 对 world 的门禁很硬：
运行时拒绝任何编译出的 `specVersion` 与该 Eve 版本内嵌数字不精确一致的
world，而这两处检查都不是类型错误——所以一套 CI 契约测试钉住配对关系，
Eve 升级会在 CI 里失败，而不是在部署时。

两条 fail-closed 规则收尾：每个 Release 携带构建时所用 world 的不可变
attestation（attestation 未知的对象直接拒绝，绝不按当前环境猜测）；
world 是构建时属性——不能对着执行中的 World 改运行时环境变量来替换。

开发环境未配置共享 world 时继续用 Eve 的本地 world。本地 world 不用于
生产从未留下书面论证——它被当作不言自明的不合适（单进程，在缩容到零下
不持久）。
