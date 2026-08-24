---
title: 为什么 OpenTelemetry 是唯一传输
description: push-first、OTel-only 的可观测性与私有 Provider，以及围绕 Agent 遥测的信任边界。
---

## 决策

Eveland 的遥测以 OpenTelemetry API、语义约定和 OTLP 作为**唯一**传输。
没有私有遥测信封、没有自造 wire 协议、没有抓取管线；fan-out 用现成的
OpenTelemetry Collector，不自研守护进程。

## 为什么是 push，且在 Release 准备时注入

平台的承诺是 Session 覆盖*每一个*入口。活在 Playground 路径上的采集会
静默漏掉直连端口、schedule、channel（Slack、webhook）和 subagent 流量。

改为拉取 Eve 事件流的方案被考虑过并因信任问题否决：Agent 若自定义
route auth，平台不存储最终用户凭证就无法读流——而存储最终用户凭证不可
接受——且 cron、channel、subagent 流量根本没有对应的 HTTP 凭证。所以
遥测由 Release 准备时注入的 observer 从 Agent 进程内部推出，流读取只
作为可选的对账手段存在，绝不是正确性前提。

注入遵循与[沙箱](/zh/docs/reference/design/sandbox)相同的规则：绝不修改
源码快照，用户的 `package.json` 绝不新增平台依赖，注入模块自包含。

## 私有 Provider，绝不碰用户的全局

注入的 observer 创建 Eveland 私有的 OTel Provider，从实例直接取
tracer/logger。它绝不注册全局 Provider、绝不安装 ContextManager、绝不
flush 或关闭用户自己的 OTel 设施——自带可观测性的 Agent 保有它的一切，
分毫不动。（这也是现成封装被否决的原因：它们假定全局 Provider 归自己。）

## 信任边界

- **两个 receiver，两级信任。** 平台 receiver 要求 Agent 拿不到的
  service token；Agent receiver 强制覆写归属属性、只接受运行时
  instrumentation scope——Agent 无法冒充平台。
- **身份是被指派的，不是自称的。** Worker 为每个 Deployment 签发凭证；
  ingest 验证后覆写自报身份，Agent 无法把数据归到别的 Deployment 名下。
- **诚实的边界写在明面上：**没有任何机制阻止 Agent 伪造*关于它自己*的
  遥测。抵御这一点需要进程外的可信 provenance，当前实现不提供该保证。
- **出口是收口点。** Agent 和平台服务都不持有外部目的地凭证；Collector
  只知道 Destination ID，API 侧代理重新施加策略、剥除内部凭证并执行
  SSRF 检查。

## 接受的代价

- **可用性高于可观测性。** observer 故障让遥测降级，绝不让 turn 失败；
  flush 有时间上限，任何环节都不 fail closed。
- **At-least-once 投递**，所以投影幂等，排序依赖 Eve 的会话内序号。
- **内置存储是摘要，不是 trace 存储。** span 级细节只在外部目的地存在；
  一个都没启用时，细节 trace 不在任何地方留存。
- **可观测性不是计费账本。** 若将来需要零丢失的 token 记账，应建独立的
  领域账本，而不是把遥测 spool 改造成非标准的账本。
- **重建有标注。** 记录的模型调用输入是从 Eve 事件流重建的，并如实标注
  为重建，而不是冒充逐字 prompt。

## 深入参考

- [可观测性行为契约](/zh/docs/reference/observability)：OTLP 批处理存储、SessionNode 树合并规则与数据保留周期
- [会话与用量追踪](/zh/docs/observe/sessions)：面向开发者的 Session 与 Usage 模型概览
- [健康与诊断](/zh/docs/operations/diagnostics)：Collector 状态检查与用量完整性排查
- [架构参考](/zh/docs/reference/architecture)：系统 Observation Path 与信号拓扑图
