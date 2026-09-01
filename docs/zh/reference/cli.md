---
title: eveland CLI
description: Agent 作者的命令行客户端——认证模型、origin 解析、凭证存储与命令面。
---

`eveland` 是平台面向 agent 作者的命令行客户端。它只走公开 `/api` 契约——与浏览器 Dashboard 同一契约——只承载平台关系动词：今天是认证，随着命令面扩展会有 deploy/logs/env。框架动词（build、test、dev）属于 `eve` 工具链；运维平台本身（start、stop、doctor、update）属于 `eveland-ctl`。CLI 随源码树住在 `packages/cli`，不发布到 npm。

## Origin 解析

每条命令都指向一个平台 origin：

1. `--origin <url>` 永远优先。值必须是裸 origin（无路径、无查询串）。
2. 否则，装有本地实例的机器上，默认取 `EVELAND_HOME/etc/eveland.env` 的 `EVELAND_PUBLIC_ORIGIN`。
3. 否则命令失败并要求 `--origin`。没有静默的 localhost 兜底：错误的默认值会把凭证发给错误的实例。

## 认证

`eveland login` 走 RFC 8628 device authorization：CLI 以预置的 `eveland-cli` public OAuth client 身份申请 device code，打印 user code，打开浏览器到 Dashboard 的 `/device` 审批页，并按服务端的 interval（及 `slow_down`）轮询 token 端点，直到已登录用户批准或拒绝。批准产出**scoped、opaque、可撤销的 access token**——scope 为 `deploy` 与 `observe`，永非全权；无论持有者角色如何，API 都把 token 认证的请求限制在 scope 映射之内。

凭证按 origin 存于 `~/.config/eveland/credentials.json`（文件 `0600`，目录 `0700`）。存放在 `~/.config` 之下，绝不放 `~/.eveland`——那是 `eveland-ctl` 拥有的 macOS appliance root。

Headless 场景（CI）设置 `EVELAND_TOKEN`：它永远覆盖存储的凭证。token 30 天过期（无 refresh token）；过期即重新 `eveland login`。

## 命令

| 命令                              | 行为                                                |
| --------------------------------- | --------------------------------------------------- |
| `eveland login [--origin <url>]`  | device flow 认证；按 origin 存储凭证                |
| `eveland logout [--origin <url>]` | 忘掉存储的凭证（已设置的 `EVELAND_TOKEN` 仍然生效） |
| `eveland whoami [--origin <url>]` | 打印 origin、用户、角色、token scope 与 token 来源  |

未知命令会提示最近的匹配，包括跨二进制提示：`eveland doctor` 会指向 `eveland-ctl doctor`。
