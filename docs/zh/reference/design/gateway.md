---
title: Agent Gateway 数据面设计决策
description: Agent Gateway 核心不变量、Host 校验、Session 亲和性绑定与安全反向代理设计。
---

Agent Gateway 刻意保持轻量与职责单一：专注于域名路由、连接保持与流式数据转发，不介入具体的业务应用状态。

---

## 1. 严格基于 Host 解析路由

- **反向代理单入口**：反向代理（如 Traefik）只需配置一条通往 Agent Gateway（端口 `17300`）的泛域名路由。
- **全主机名解析**：网关使用规范化的完整请求 Host 匹配数据库中的路由规则，严禁通过客户端自定义 Header（如 `x-project-id`）来指定目标租户，防止租户越权。
- **域名模型**：生产稳定域名（`<projectSlug>.<domain>`）与预览域名（`<deploymentKey>--<projectSlug>.<domain>`）均保持在单级子域名内，单张泛域名证书即可覆盖全部路由。

---

## 2. 请求头清洗与安全边界

- **清理不受信任 Header**：客户端传入的 `Forwarded`、`X-Forwarded-*` 以及平台保留的 `X-Eveland-*` 均会被网关强制剥除，仅在可信连接建立后由网关重新注入。
- **严禁重写 Host 为 localhost**：Eve 框架的 `localDev()` 鉴权通过判断请求 Host 是否为 `localhost` / `127.0.0.1` 来放行本地调试。如果网关在向上游转发时将 Host 改写为回环地址，会导致公网请求意外获得本地调试的高危权限。因此网关向上游转发时始终保留原始的规范化公网 Host。
- **业务凭据透明转发**：客户端请求自带的 `Authorization`、`Cookie` 以及 Eve 协议头均原样透明转发，网关不越权解密或篡改。

---

## 3. 会话亲和性高于路由加权 (Session Affinity)

Agent 对话通常是多轮长连接交互，后续轮次可能在数小时或数天后发生。如果每次请求都重新计算灰度加权，会导致同一会话的第二轮对话被路由到其他部署版本，破坏会话连续性：

- **会话持久绑定**：在 Agent 创建会话并返回 Session ID 后，网关立即持久化 `SessionBinding`。后续对话、流式监听和取消请求严格路由至绑定的 Deployment。
- **优雅排障 (Draining)**：调整灰度权重或回滚版本时，存量会话继续留在原部署上平稳执行，新策略仅对新创建的根会话生效。
- **有界保留**：会话绑定受空闲 TTL 控制（Playground 默认 24 小时，公网 API 默认 7 天），过期会话返回明确的 `410 session_expired`。

---

## 4. 字节级流式透明透传

上游 Agent 返回的响应流（NDJSON）直接以流式透传给客户端，网关不做内存缓冲。这不仅提供了极低的延迟，而且确保了即使上游框架更新了协议版本或增加了事件类型，网关也无需修改适配代码，保持长期的向前兼容性。

## 相关参考

- [配置 Agent 流量与反向代理](/zh/docs/production/networking)：网络与端口规划
- [路由契约规范](/zh/docs/reference/routing)：Route Policy 与会话绑定规则
- [安全模型](/zh/docs/operations/security)：网关网络安全边界与凭据保护
