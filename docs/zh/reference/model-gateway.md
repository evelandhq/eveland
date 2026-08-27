---
title: Model Gateway
description: BYOK 模型数据平面的行为参考——字符串模型解析、实例绑定 Token、Provider 注册表与安全契约。
---

Model Gateway 是 Eveland 自己的模型数据平面：Agent 只写一个裸的 Gateway 风格模型
字符串——`defineAgent({ model: "zai/glm-5.3-flash" })`——平台就会经**运维者**连接的
Provider 解析它，凭据对 Agent 永不可见。它说 AI SDK Gateway 的 Wire 协议
（`POST /v4/ai/language-model`、`GET /v4/ai/config`），因此 Eve 与 AI SDK 不需要任
何 Eveland 专用客户端；但它从不代理到 Vercel 的推理服务：每个调用都直接重放到配置
好的 BYOK Provider。

## 启用与解析

在 Worker 配置 `EVELAND_MODEL_GATEWAY_URL`（`model-gateway` 服务面向 Deployment 的
Origin）之前，功能保持关闭。配置后，Worker 经 Reserved 运行时环境层把它注入每个
Deployment，Release 构建会把一个自包含的 Hook Runtime 与 Hook Shim 烘焙进根
Agent。导入该 Hook 会在任何 Turn 解析字符串模型之前，把 Eveland Gateway 安装为
AI SDK 的全局默认 Provider——Agent 代码零改动。未设置该变量时 Hook 是 No-op，字符
串模型保持默认解析；既有 Deployment 只在重建或重启后改变行为，绝不静默切换。
Provider 对象形式的模型（如 `deepSeek(...)`）两种情况下都不受影响：Model Gateway
是字符串模型的默认落点，不是模型出口防火墙。

一个构建期注意事项在上游改动前仍然存在：除非 Agent 显式声明
`modelContextWindowTokens`，`eve build` 会从 Vercel 的公开模型目录解析字符串模型
的 Context Window 元数据。显式声明它可让构建完全不依赖该端点。

## Token

Deployment 用实例绑定的运行时 Token（`AI_GATEWAY_API_KEY`，前缀 `emg_`）认证：
Worker 在每次进程启动（Activation、Restart、首次部署）时新铸，服务端只以 SHA-256
哈希存在 RuntimeInstance 行上，且仅在该实例处于存活状态时有效。实例停止、失败或
归档即吊销——停止的进程不留任何可用凭据，其 Token 的下一个请求即 401。构建永远看
不到 Token：Reserved 环境剥离使所有保留名不进入构建环境。

成员还可以从 Dashboard 铸造个人 API Key（前缀 `emk_`），供 Deployment 之外的调用
方使用。原始 Key 只显示一次；只有哈希持久化，吊销即时间戳。实例 Token 把调用归属
到 `project:<id>`，个人 Key 归属到 `user:<id>`，Gateway 按调用方实施并发上限
（`MODEL_GATEWAY_MAX_CONCURRENT_PER_SUBJECT`），任何调用方都无法耗尽共享的
Provider 配额。

## 注册表

Provider 连接与模型路由存放在 Eveland 自己的注册表中，它是路由真相：

- **Provider 连接**是一个 OpenAI 兼容端点加凭据，静态加密于专用的
  `EVELAND_MODEL_GATEWAY_SECRET_KEY` 之下——有意独立于 `APP_SECRET_KEY`，因此
  Model Gateway 永远无法解密项目 Secret。保存连接会先对端点验证凭据并 Fail
  Closed：被拒绝的 Key 绝不入库。
- **模型路由**把规范 Id（`zai/glm-5.3-flash`）映射到一个连接及 Provider 自己的模
  型 Id。一个模型可用，当且仅当其路由的 Provider 已连接。
- 每次注册表变更都追加一条审计事件；审计从不包含凭据。

BYOK 是严格的：Gateway 只使用运维者配置的凭据，无 Provider 可服务某模型时 Fail
Closed。不存在任何回退到平台或 Vercel 账户的路径。

## 安全契约

Agent 是不可信调用方。Gateway 对每个请求校验协议（仅 Specification Version 4）、
丢弃客户端提交的上游 Header、以 400 拒绝请求级的 Gateway 路由选项（`byok`、
`order`、`only`、`models`、`serviceTier` 等）而非静默忽略——唯一接受的是 Eve 自带
的 `caching` 提示（剥离语义），并对上游失败做脱敏，使 Provider URL 与凭据永不到达
调用方。Provider、Base URL 与凭据选择只来自注册表。客户端 Abort 会传播到上游
Provider 调用。

保持服务私有：裸机上绑定回环（`MODEL_GATEWAY_HOST`），Compose 服务只做仅回环的端
口发布且无公开路由。Docker Agent 容器经 `host.docker.internal` 访问；systemd
Deployment 共享宿主网络命名空间，使用 `127.0.0.1`。

## Dashboard

主导航中的 Model Gateway 板块承载成员面（Overview、可复制字符串的 Models 目录、
个人 API Keys）与管理面（带保存即验证与审计的 Providers；路由管理内联在 Models
页）。按模型的用量仍在 Usage 页，数据源是 Observer 管线——Gateway 自身从不重复统
计业务用量。
