---
title: 配置网络与反向代理
description: 配置泛域名 DNS、通配符 TLS 证书、Traefik 反向代理与 Agent Gateway 接入网络。
---

在 Eveland 架构中，**Agent Gateway 是所有 Agent 流量唯一公开的入口前门**（监听本地回环端口 `17300`）。Agent 进程的真实动态端口仅绑定在本地回环，绝不直接对外暴露。

## 1. 域名与 DNS 解析规划

为 Agent 访问配置一条指向宿主机公网 IP 的泛域名（Wildcard）解析记录：

```text
*.agents.example.com  A  <宿主机公网 IP>
```

配置完成后，平台将基于该泛域名自动生成以下访问地址：

- **生产稳定路由 (Stable)**：`<projectSlug>.agents.example.com`
- **专属预览路由 (Preview)**：`<deploymentKey>--<projectSlug>.agents.example.com`
- **自定义别名路由 (Alias)**：`<aliasName>.agents.example.com`

_注：预览地址中的 `--` 分隔符保持在单级子域名内，因此单张 `*.agents.example.com` 证书即可覆盖所有路由。_

## 2. 申请通配符 TLS 证书

公共 CA（如 Let's Encrypt）要求通配符证书必须通过 **ACME DNS-01 挑战** 签发（HTTP-01 无法验证 `*.` 规则）。建议在反向代理（如 Traefik 或 Caddy）中配置自动化 DNS 验证插件，实现通配符证书的自动申请与续期。

## 3. 配置反向代理 (以 Traefik 为例)

反向代理负责终止公网 TLS，并将流量转发至宿主机 `127.0.0.1:17300`。参考 `infra/traefik/agents.yml`：

```yaml
http:
  routers:
    # 平台控制台与 API
    eveland-console:
      rule: "Host(`console.example.com`)"
      entryPoints: ["websecure"]
      service: "eveland-gateway"
      tls: {}

    # Agent 泛域名流量
    eveland-agents:
      rule: "HostRegexp(`{sub:[a-z0-9-]+}.agents.example.com`) && !PathPrefix(`/internal`)"
      entryPoints: ["websecure"]
      service: "eveland-gateway"
      tls: {}

  services:
    eveland-gateway:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:17300"
```

### 反向代理关键规则

1. **全路径透传**：保持规则对路径透明，确保 `/eve/*` 与 `/.well-known/workflow/*` 均能正常到达网关。
2. **严禁放行 `/internal/*`**：`/internal/*` 属于平台机器间服务认证接口，**严禁从公网代理路由访问**。

## 4. 宿主机内部端口规划与防火墙策略

| 端口号          | 绑定接口    | 协议/服务               | 安全策略                           |
| :-------------- | :---------- | :---------------------- | :--------------------------------- |
| `80` / `443`    | 公网接口    | HTTP / HTTPS (Traefik)  | **允许公网入站**                   |
| `17300`         | `127.0.0.1` | Agent Gateway 前门      | 仅本地访问，反向代理转发目标       |
| `17301`         | `127.0.0.1` | 平台 API                | 仅本地回环访问                     |
| `17302`         | `127.0.0.1` | Dashboard 控制台        | 仅本地回环访问                     |
| `17310`         | `127.0.0.1` | 内置 Postgres           | **严禁公网访问**，仅供本地服务连接 |
| `17311`–`17314` | `127.0.0.1` | OTel Collector 接收端点 | 仅供宿主机进程与 Agent 发送遥测    |
| `18000`–`18999` | `127.0.0.1` | Agent 实例动态端口      | 仅供 Gateway 内部转发，切勿暴露    |

在宿主机防火墙（UFW 或安全组）中，通常**仅需开放 `80` 与 `443` 端口**即可。

下一步：[生产链路验证与验收](/zh/docs/production/verify)。

## 相关参考

- [网关数据面设计决策](/zh/docs/reference/design/gateway)：网关不变量、Host 校验与安全代理
- [路由契约规范](/zh/docs/reference/routing)：域名解析与会话绑定规格
- [安全模型](/zh/docs/operations/security)：网络边界与凭证隔离
