---
title: Playground 调试台契约
description: Playground 传输协议、流式生命周期、客户端调试认证矩阵与受管连接验证规范。
---

Playground 是 Eveland 控制台内置的交互式调试环境，直接连接目标 Deployment 进行端到端测试。本页规定其交互契约与认证规范。

---

## 1. 传输与会话生命周期

- **流式传输协议**：前端通过内部受服务凭证保护的专用网关路径与 Agent 通信，增量接收 NDJSON 流式输出（包含文本分块、思维链推理 reasoning、工具调用及人机协同 HITL 请求）。
- **页面与会话映射**：每次打开或刷新 Playground 会新建一个干净的 Eve Session。同一页面内的后续对话、工具交互均复用该 Session。
- **协作式流取消**：在流式生成中点击停止时，客户端向服务端发送规范的 `cancel()` 命令并等待确认边界到达，确保服务端状态的一致性。
- **附件上传限制**：单次最多支持上传 4 个附件（文本、代码、图片或 PDF），单文件不超过 5 MiB，总大小不超过 10 MiB。

---

## 2. 客户端调试认证矩阵 (Playground Authentication)

当被调试的 Agent 启用了接口认证保护时，可在 Playground 设置中配置调用凭证：

| 认证方法               | 认证凭据行为                                                                                | 适用场景                                  |
| :--------------------- | :------------------------------------------------------------------------------------------ | :---------------------------------------- |
| **`none`**             | 不发送额外鉴权 Header，使用项目标准域名发起请求。                                           | 公开无需认证的 Agent。                    |
| **`eveland-identity`** | 发送由 Eveland 签发的短期 Caller Token，Agent 的 `evelandIdentity()` 守卫可精准识别调试者。 | 采用 Eveland 统一身份体系的 Agent。       |
| **`basic`**            | 发送 HTTP Basic 账号及引用的项目密钥密码。                                                  | 采用 Basic Auth 保护的 Agent。            |
| **`bearer`**           | 发送外部签发的 Bearer Token（支持引用项目密钥）。                                           | 采用静态 Token 鉴权的 Agent。             |
| **`oidc`**             | 独立的 Authorization Code + PKCE 流程，动态获取并自动刷新 Access Token。                    | 对接企业通用 IdP（如 Auth0 等）的 Agent。 |
| **`headers`**          | 发送显式配置的自定义请求 Header。                                                           | 依赖自定义鉴权头或特殊网关标记的 Agent。  |

---

## 3. 凭据安全存储与请求信封

- **机密数据零泄漏**：Playground 使用的密码、私钥或自定义 Header 均加密保存在数据库中，仅在发起单次调试请求时由 API 动态解密并装入信封传递给网关，不会保存在浏览器或网关日志中。
- **与业务数据隔离**：Playground 仅作为调试客户端，其配置与生产路由的公开鉴权相互独立，互不影响。

## 相关参考

- [密钥与连接配置](/zh/docs/agents/secrets-connections)：开发者密钥与调试配置指南
- [安全模型](/zh/docs/operations/security)：机密落盘加密与网关请求信封机制
- [Agent 身份契约](/zh/docs/reference/identity)：Caller Token 与身份鉴权规范
