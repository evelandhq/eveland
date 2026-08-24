---
title: Agent Gateway 不变量
description: Agent Gateway 绝不能打破的数据面规则，以及缺了每一条会坏什么。
---

Agent Gateway 刻意保持"笨"：它路由、固定、流式转发——绝不解释身份，
绝不拥有应用状态。下面每条不变量背后都有设计时点名的具体故障。

## 按 Host 路由，从数据库解析

Traefik 只有一条通往 Gateway 的 wildcard 路由。Gateway 规范化 Host，
拒绝配置的基础域名之外的主机名，并用**完整主机名**在存储的 Agent 路由
里解析目标。它绝不接受客户端传入的 project/deployment header——否则一个
header 就能挑选租户。

Stable、preview 和别名主机都是单个 DNS label（`<slug>` 与
`<deploymentKey>--<slug>`），一张 wildcard 证书覆盖所有路由形态。未知
Host 与被禁用的路由都返回 404——错误面不得暴露私有 Project 是否存在；
503 只留给"路由存在但没有可运行目标"。

## Header 信任边界

外部传入的 `Forwarded`/`X-Forwarded-*` 和所有保留的 `X-Eveland-*` header
一律剥除并基于可信连接重建；Agent 自己的 `Authorization`、`Cookie`、
`Origin` 和 Eve 协议 header 原样透传。

最锋利的一条规则背后是有名有姓的漏洞：**绝不把公开请求的 Host 重写为
loopback。** Eve 的 `localDev()` 按 URL 主机名授予身份——`localhost`、
`*.localhost`、`127.0.0.0/8`——所以一个"贴心地"把 Host 改成 loopback 上游
的代理，会把每一个来自公网的请求变成受信任的本地开发者。Gateway 即使
向 `127.0.0.1` 的上游转发，也保留 canonical 公开 Host。

Gateway 不是身份提供者。唯一的刻意修订是 Open access 模式：对**完全
没有** `Authorization` 的请求注入 Caller Token——但依然绝不检查或替换
调用者自带的凭证，因为 Gateway 无法校验外来凭证，转发一个坏 token 比
不带更糟。

## Session 固定高于路由权重

Eve Session 是持久多轮的——下一轮可能几天后才来。按请求加权会把一段
对话的第二轮落到另一个 Release 上：不同的代码、不同的持久状态。所以
A/B 权重只为**新的根 Session** 挑选 Deployment；Eve 一返回 session id，
Gateway 就在响应前持久化绑定，此后 continuation、cancel、stream、reset
一律经绑定解析。调权重不会移动已有 Session；权重降为零的目标不再接收
新 Session，但继续服务已绑定的。

固定是有界的，不是永恒的：空闲 TTL 会让绑定过期，过期的 Session 得到
稳定的 `410 session_expired`——绝不静默改道到不同的代码上。

## 响应字节级透传

上游响应 body 以流原样通过；NDJSON 绝不缓冲。透明不只是体验，更是兼容
策略：因为 Gateway 不解析流，大约十四个 Eve minor——格式微调、新
header、stream 版本号变更——都没有需要 Gateway 加 adapter 分支。（请求
body 是例外：在配置的上限内缓冲，因为路由需要检查 create/reset body。）

## 特权内部路径

Playground 通过 service-authenticated 的 `/internal/*` 路径访问 Eve，这是
*唯一*允许使用 loopback Host 的地方——它为管理员而设，管理员合法地获得
Eve 的 local-dev 身份。它正是上面被禁止的 Host 重写的"获准的孪生"，也
正因此它必须对公开代理不可达，并以网络和 service credential 双重隔离。

## 滑动的 fail-closed 兼容窗口

Eveland 支持一个由*完整验证过的* Eve minor 组成的滑动窗口。导入、构建、
重启、冷激活、Playground 和 scheduler 适配器共享同一道门禁，窗口之外的
版本一律拒绝。窗口绝不因为 npm 上出现新版本而自动变宽——只有在审阅
release note、对耦合面做源码 diff、并用真实发布包跑完 fixture 矩阵之后
才移动。窗口保留多个 minor，是为了升级 Eveland 绝不把还在上一条线上的
Agent 晾在原地；能力地板（比如持久路由）返回显式错误而不是降级。

当前窗口与各线状态见 [Eve 兼容性](/zh/docs/reference/eve-compatibility)。

## 深入参考

- [配置 Agent 流量](/zh/docs/production/networking)：Wildcard DNS、TLS、反向代理与私有端口
- [路由与 Deployment 生命周期契约](/zh/docs/reference/routing)：Route Policy、两目标加权与 Session 绑定
- [Eve 兼容性窗口](/zh/docs/reference/eve-compatibility)：滑动兼容窗口与受支持版本范围
- [安全模型与网络边界](/zh/docs/operations/security)：Host 重写防护、内部特权路径与凭据隔离
