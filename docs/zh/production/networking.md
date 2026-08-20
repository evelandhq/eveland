---
title: 配置 Agent 流量
description: 配置 Wildcard DNS、TLS、Traefik、Agent Gateway 与私有 Deployment 端口。
---

Agent Gateway 是 Agent 流量唯一公开入口。原始 Deployment 端口只是私有实现细节。

## DNS

为 Agent Base Domain 配置指向宿主机的 Wildcard 记录，例如 `*.agents.example.com`。`EVELAND_AGENT_BASE_DOMAINS` 的第一个值是被物化进路由的 Canonical Domain；生产环境通常只用一个值。

## Hostname

- Stable：`<projectSlug>.<agentBaseDomain>`
- Preview：`<deploymentKey>--<projectSlug>.<agentBaseDomain>`
- Named Alias 使用相同 Wildcard Domain。

Project Slug 全局唯一且不可变。Deployment Key 恰好由八个小写字母或数字组成，在其 Project 内唯一；完整的 `proj_*` 与 `dep_*` ID 始终是内部平台身份。Preview 分隔符 `--` 保持在一个 DNS Label 内，因此一张 Wildcard Certificate 即可覆盖 Stable、Preview 与 Alias Route。

## Wildcard TLS

公共 CA 只通过 ACME DNS-01 Challenge 签发 Wildcard Certificate——HTTP-01 无法验证 `*.` 名称。在反向代理上使用能通过 DNS 服务商 API 写入 Challenge TXT 记录的 ACME 客户端终止 TLS（Traefik 对应 `dnsChallenge` Certificate Resolver），并让其自动续期。

## Reverse Proxy

从 `infra/traefik/agents.yml` 开始配置：替换示例域名，在此终止 TLS，并将 Wildcard Agent Host 转发到宿主机端口 `4080` 上的 Agent Gateway。该端口保持宿主机私有，并保留 `!PathPrefix('/internal')` 排除规则。

保持 Wildcard 规则对路径透明。Eve Task-input Callback 与自定义 MCP Channel 路径必须到达与常规 Session Route 相同的 Agent Gateway Catch-all；不要添加绕过 Agent Gateway 目标选择或冷激活的路径专属代理规则。如果你曾在 Deployment 正前方按路径路由，必须**同时**转发 `/eve/` 与 `/.well-known/workflow/`——Workflow World 把 Run Callback 投递到 `/.well-known/workflow/v1/flow`，只转发 `/eve/` 会让 Session 能启动但所有 Run 静默卡死。

## 私有端口

- Agent 进程绑定 `127.0.0.1:41xxx`。永远不要把这些动态端口加进 Traefik 或防火墙规则。
- 托管 Collector 的 Receiver（平台侧 Loopback `4317`/`4318`，Agent 侧 `4327`/`4328`）绝不能发布到公开接口。
- API（`4000`）与 Agent Gateway 的内部控制面在代理之后保持仅 Loopback。

## Agent Gateway 边界

Agent Gateway 验证完整 Canonical Host，移除不受信任的 Forwarding Header 与保留的 Eveland Header，再重建可信平台 Header。它保留 Agent 自己的 Authorization、Cookie、Origin 语义、请求流与 NDJSON 响应流。

`/internal/*` 下由 Service Authentication 保护的 Playground 与 Activation Route 必须对公开代理保持不可达。

下一步[验证平台](/zh/docs/production/verify)。
