---
title: 缩容到零
description: Deployment 是持久地址，进程是可丢弃的。其余一切都从这个拆分推导出来。
---

## 决策

Deployment 是持久、可寻址、不可变的目标。它背后的操作系统进程是可丢弃
的：最后一份活跃工作结束五分钟后空闲即停；任何需要它运行的东西——公开
请求、活跃 stream、执行中的 turn、schedule dispatch、workflow step——都
必须持有一个有时限的 activation lease。持久停靠的 Session **不会**让
进程保持存活。

这是[密度论证](/zh/docs/reference/design/runtime)的后半部分：systemd 让
休眠 Agent 几乎零成本，缩容到零让休眠成为默认状态。

## 冷激活：特权拆分

发现休眠的组件永远不获得宿主机特权：

1. Agent Gateway 发现被选中的 Deployment 处于休眠。
2. 它调用一个 service-authenticated 的内部激活端点。
3. API 入队（并合并）激活任务——它不持有 Docker 或 systemd 特权。
4. Worker——唯一有特权的组件——启动预构建的 Release 并发布就绪。冷启动
   绝不重装依赖、不重新构建源码。
5. Gateway 在有界的冷启动预算内等待，然后代理请求，原始的认证、header、
   body 流、abort 信号和 NDJSON 响应流原样保留。

Session 固定跨越休眠：continuation 唤醒 SessionBinding 早已选定的那个
Deployment，绝不重跑路由加权。

## 平台为什么拥有 cron 时钟

Eve 的 schedule 计时器跑在进程内，这与设计的两半都冲突：休眠的进程没有
时钟；而 preview 和 A/B Deployment 并发存活时，_每个活着的进程都有自己
的一份时钟_——preview 会独立执行生产业务的 schedule。

所以准备好的 Release 保留 schedule 注册以兼容 Eve，但把原生 handler
替换为 no-op；只有 Eveland 的认证 dispatch 路径会调用保留的原始定义。
Eveland 拥有时钟和 Postgres 里的 ScheduleRun 账本；注入的 Scheduler
Channel 是临时唤醒进程内的执行 RPC，不是守护进程。cron 精确指向一个
Deployment——绝不经过加权的 Gateway 路由——preview 和候选版本不会仅仅
因为活着就执行业务 cron。Worker 重启后从 Postgres 重新发现到期工作，
内存计时器只是唤醒提示。漏掉的 tick 合并为至多一次补跑并记录漏掉的
数量，绝不无界回放。

## 接受的代价

- **冷启动延迟真实存在且有界。** Gateway 最多等待配置的预算（默认
  30 秒），请求要么继续要么可见地失败；等待期间入站 body 保持背压而
  不是被缓冲。
- **At-least-once，不是 exactly-once。** Eveland 保证每个到期 tick 一条
  持久 ScheduleRun 和幂等的 dispatch 认领；作者编写的副作用仍需自己的
  幂等性。结果不可知的 dispatch 进入终态 `dispatch_unknown`，由运维带
  审计地重试——绝不自动回放。
- **dispatch 不等于执行完成。** 返回 Session ID 的 schedule dispatch 要
  持有 lease 直到每个返回的 Session 报告根 turn 边界；五分钟空闲 TTL 是
  激活超时，不是执行超时。
- **就绪必须证明端口属主。** 一个后来才发现的坑，现已是不变量：就绪
  检查验证监听 socket 属于 Worker 启动的那个进程，Gateway 才不会把流量
  代理给抢占了端口的陌生进程。

## 深入参考

- [为什么是 systemd 而不是 Docker](/zh/docs/reference/design/runtime)：运行时密度与休眠边际成本
- [路由与 Deployment 生命周期契约](/zh/docs/reference/routing)：ActivationLease、端口预留与冷启动
- [Schedules 与自动化任务](/zh/docs/observe/schedules)：面向开发者的定时调度与唤醒概览
- [Schedule 执行行为契约](/zh/docs/reference/scheduling)：Planner、Prewarm 与状态机规范
