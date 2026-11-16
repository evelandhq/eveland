---
title: Channel、Webhook 与回调
description: 给 Slack、Twilio、OAuth 提供方、远程 Agent 和 workflow webhook 填哪个公开 URL，以及入站流量如何到达 Deployment。
---

Eveland 上的 Agent 只能经 Agent Gateway、通过项目的公开主机名访问。进程本身监听一个外部调用方无法访问的私有 Loopback 端口。因此，登记到任何外部服务的 URL 都必须使用公开主机名。

## 1. 公开 URL

| URL                                                               | 到达                                                         | 用途                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------ |
| `<scheme>://<project-slug>.<agent-base-domain>`                   | 稳定路由：已发布的 Deployment，或按权重分配的两个 Deployment | 登记到外部服务的一切地址 |
| `<scheme>://<deployment-key>--<project-slug>.<agent-base-domain>` | 一个 Deployment                                              | 发布前测试预览           |

scheme、基础域名和端口由实例决定（见[路由](/zh/docs/reference/routing)）。预览主机名属于某一个 Deployment，该 Deployment 不再受保护后会被保留策略归档，因此只把稳定 URL 登记到 Slack 等平台；如果预览也要接收真实事件，请另建一个 app 或 bot。

## 2. Channel

eve 的 channel 在 Agent 内部挂载路由，例如 Slack channel 的 `POST /eve/v1/slack`，自定义 channel 则挂在它声明的路径上。Agent Gateway 把项目主机名上的每个路径原样转发给 Agent，请求体、`Authorization` 和 Cookie 都不改动，因此 channel 自己的请求校验（Slack 的签名密钥、Twilio 的签名、路由鉴权）照常工作。在平台上配置稳定 URL 加 channel 路由，例如 `https://support.agents.example.com/eve/v1/slack`。

关于入站 channel 流量：

- **对完整 URL 签名。** Agent 看到的是公开 `Host`，以及 Agent Gateway 丢弃客户端自带值后重新设置的 `X-Forwarded-Proto` 和 `X-Forwarded-Host`。如果 channel 对完整请求 URL 校验签名（如 Twilio），请显式设置 channel 的公开 URL（Twilio 的 `webhookUrl`，语音回调还需 `publicBaseUrl`），不要依赖 TLS 终止之后请求 URL 的重建方式。
- **冷启动。** 因空闲而停止的 Deployment 会被下一个请求唤醒，该请求最多等待 30 秒。投递超时较短的平台（如 Slack 的 3 秒）可能会重试空闲后的第一个事件。
- **加权路由。** channel 路由的路径里没有会话 ID，因此每个入站事件都按稳定路由的权重分配。加权发布期间，同一对话的相邻事件可能在不同 Release 上执行路由处理函数。见[发布与流量路由](/zh/docs/agents/releases-routing)。
- **保留路径。** 对 `/.well-known/workflow/v1/*`（下文的 webhook 路由除外），以及 `/eve/v1/session` 下不属于 eve 会话路由的路径，Agent Gateway 返回 `404`。eve 把 `/eve/v1/*` 留给自己的 channel，因此自定义 channel 的路由请声明在它之外。

## 3. Connection 登录（OAuth）与远程 Agent 回调

eve 用 `WORKFLOW_LOCAL_BASE_URL` 生成 connection 的登录链接，以及父 Agent 交给远程 Agent 的回调 URL。Eveland 在每个 Deployment 中把这个变量设为项目的公开 Agent origin，因此两者无需配置即可工作：

- 在 OAuth 提供方处用稳定主机名登记重定向 URI。从项目任一 Deployment 发起的登录都在那里完成，对话轮次在发起它的 Deployment 上恢复。
- 远程 Agent 会拒绝本身是或解析到私有、保留 IP 地址的回调主机。如果你的实例的 Agent 基础域名只在内网中解析，内网之外的远程 Agent 无法回调。
- 该变量是保留变量；同名的项目或共享条目会被覆盖。见 [Agent 环境](/zh/docs/reference/agent-environment)。

## 4. Workflow webhook

`execute` 为 workflow 的工具可以用 `eve/workflow` 的 `createWebhook()` 创建 webhook，并把它的 URL 交给外部调用方。eve 1.0 用进程监听的地址生成该 URL，因此在 Eveland 上 `webhook.url` 指向外部调用方无法访问的 `http://localhost:<port>`。请改用项目 origin 与 webhook 路径拼出公开 URL：

```ts
import { createWebhook } from "eve/workflow";

const webhook = createWebhook();
const publicUrl = new URL(new URL(webhook.url).pathname, process.env.WORKFLOW_LOCAL_BASE_URL).href;
// https://support.agents.example.com/.well-known/workflow/v1/webhook/<token>
```

Agent Gateway 对任何方法都转发 `/.well-known/workflow/v1/webhook/<token>`，并会为它唤醒已停止的 Deployment。token 是唯一的凭据：未知或已用过的 token 返回 `404`。`/.well-known/workflow/v1/*` 的其余部分是 workflow 队列的私有接口，外部永远无法访问。

## 相关参考

- [路由与部署生命周期](/zh/docs/reference/routing)：主机名、权重、会话绑定与冷启动
- [Agent 环境](/zh/docs/reference/agent-environment)：保留变量，包括 `WORKFLOW_LOCAL_BASE_URL`
- [已知限制](/zh/docs/reference/known-limitations)：Eveland 不支持的内容
- [配置 Agent 流量](/zh/docs/production/networking)：Agent Gateway 前面的 DNS、TLS 与反向代理
