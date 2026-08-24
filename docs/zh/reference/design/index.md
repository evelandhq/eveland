---
title: 设计决策
description: Eveland 为什么长成这个样子——平台结构性选择背后有据可查的理由。
---

这一节记录 Eveland 结构性决策背后的**为什么**。行为契约在仓库根部的
`spec.md`，运维事实在本文档站的其余章节；这里解释产生它们的推理过程，
内容整理自 2026 年 8 月平台开源时的内部规划记录。
第零号决策——为什么要做 Eveland——见[为什么有 Eveland](/zh/docs/why)。

两条约定保证这些页面的诚实性：

- 这里的每条理由都是决策当时真实写下或由维护者口述的。凡是没有留下书面
  论证就定案的选择，页面会直接写"该决策没有留下书面理由"，而不是事后
  编造一个。
- 决策连同真实考虑过的备选方案与自愿接受的代价一起呈现，成本与收益
  并列。

贯穿每一页的同一条原则：**机器为 Agent 服务，而不是为基础设施服务。**
运行时、沙箱、缩容到零和 Workflow 的决策，优化的都是一台自托管机器能
养活多少有用的 Agent，以及宁可显式失败也不神秘失败。

| 页面                                                     | 解释的决策                                      |
| -------------------------------------------------------- | ----------------------------------------------- |
| [运行时](/zh/docs/reference/design/runtime)              | 生产为什么跑 systemd 而不是 Docker              |
| [沙箱](/zh/docs/reference/design/sandbox)                | 为什么自研 bubblewrap 沙箱后端                  |
| [缩容到零](/zh/docs/reference/design/scale-to-zero)      | Deployment 为什么空闲即停，冷激活为什么长这样   |
| [Workflow](/zh/docs/reference/design/workflow)           | 为什么用外置 dispatcher 和自建的 Workflow World |
| [Agent Gateway](/zh/docs/reference/design/gateway)       | 数据面不变量，以及缺了每一条会坏什么            |
| [可观测性](/zh/docs/reference/design/observability)      | 为什么 OpenTelemetry 是唯一的遥测传输           |
| [身份](/zh/docs/reference/design/identity)               | Agent 为什么只见 brokered Caller Token          |
| [Agent Catalog](/zh/docs/reference/design/agent-catalog) | Catalog 为什么是投影，以及聊天客户端契约        |
