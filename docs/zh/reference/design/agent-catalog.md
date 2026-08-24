---
title: Agent Catalog 与聊天客户端
description: 派生的 Catalog、客户端中立的认证协议，以及为什么一个聊天客户端服务所有 Agent。
---

## Catalog 是投影，不是注册表

`GET /agent-catalog` 回答一个问题：*这个安装上有哪些 Eve 客户端可以聊的
Agent？*成员资格由两个事实派生：部署的 Source Revision 默认导出标准的
`eveChannel(...)`，且 Project 有可路由的 Stable Deployment。没有需要
另行创建的 Catalog 记录，所以 Catalog 不可能与现实漂移。

设计时记录的非目标：不做 marketplace、分类、搜索、发布审核；不按 auth
函数过滤；不探测 Agent；不承载业务授权。Catalog 读 Stable 路由**已部署**
的 Revision——绝不读 Project 更新但未部署的源码——因为它公示的是客户端
*现在*就能对话的东西。缩容到零的 `stopped` Deployment 依然入选：门槛是
可路由，不是正在运行。

身份是 `issuer + projectId`，不是 URL。Stable URL 变更不得在客户端里
凭空造出第二个 Agent；聊天历史必须在 Agent 下线或退出 Catalog 后幸存。

## 认证 continuation 协议

Route 认证发生在任何 Eve session 存在之前，所以 Eve 的会话内授权事件
物理上无法承载它。取而代之：想要 Eveland 身份的 Agent 用标准 `401`
challenge 应答并给出 Eveland 的授权 URL；客户端进入 Eveland 的通用
登录，provider 由 Eveland 挑选，一个短时效、单次使用、带签名的
continuation 把调用者送回来——只送回管理员 allowlist 里的 return
target，绝无开放重定向。

两条规则保住协议的客户端中立：

- **Catalog 成员资格绝不意味着发送 token。** 客户端先遵守 Agent 自己的
  route auth，Agent 主动要求时才进入 Eveland 流程；Eve 的 route auth 是
  有序回退列表，`evelandIdentity()` 必须放行后续项（Basic、local-dev）
  的尝试。
- **客户端保持薄。** 它绝不拼接 provider 授权 URL、看不到 provider
  选择、除内存中的短时效 token 外不持有身份状态。任何客户端——浏览器
  或 CLI——都能实现同一契约。

## 为什么是一个聊天客户端（Dawn）

[Dawn](https://github.com/evelandhq/dawnchat) 是 Eveland 面向 Eve Agent
的网页聊天，它的存在源于一个关于规模的观察：认真运行 Agent 的组织，
最终 **Agent 数量会超过人数**。在这个比例下，每个 Agent 配一个前端不是
工程选型，是跑步机——而认证让它雪上加霜：组织内部通常只有一套授权体系，
N 个前端就要把它重新实现 N 次。

Dawn 把这件事倒了过来：Agent Catalog 加一个统一聊天界面，意味着**新
Agent 写出来、进入 Catalog 的那一刻就能聊**——不用写前端、不用做登录页、
不用注册 OIDC client。登录一次，与安装信任你可见的所有 Agent 对话；
Agent 作者写一行 `evelandIdentity()` 就发布。

Channel 集成（Slack、飞书、企业微信）仍是把 Agent 送到用户所在处的一等
方式。Dawn 额外主张的是保真度：它把 reasoning 和 tool-calling 过程随流
渲染出来——这才是现代 LLM 聊天体验，消息桥接给不了。

Dawn 是*一个*客户端，不是*唯一的*客户端——上面的 continuation 协议刻意
保持任何客户端可实现，CLI 从一开始就被当作对等客户端来预期。
