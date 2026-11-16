---
title: Agent 环境变量与密钥层级契约
description: 详细规范：项目变量与密钥、共享环境（Shared Agent Environment）、构建期可见变量与持久化记忆路径。
---

Agent 运行时的环境变量由三层组合而成，具有严格的确定性优先级：

$$\text{平台共享环境 (Shared)} < \text{项目密钥与变量 (Project)} < \text{平台保留变量 (Reserved)}$$

---

## 1. 项目专属变量与密钥 (Project Settings)

用于配置单个 Agent 运行所需的特定变量或敏感 Key：

- **类型区分**：
  - `variable`：普通非机密环境变量（如 `LOG_LEVEL`、`MODEL_NAME`）。允许在依赖构建与打包阶段被脚本读取以生成 Release Manifest。
  - `secret`：敏感机密（如 API Key、数据库密码）。仅在运行实例启动时注入进程，**绝不进入代码归档、构建沙箱、日志或客户端响应**。
- **配置上限与批量导入**：支持单项目最多 50 组变量；支持粘贴 `.env` 文件一键解析、预览与批量保存。
- **异步生效**：修改或删除环境变量后，平台会自动为该项目名下所有处于 `running` 或 `draining` 状态的部署排入异步重启任务，复用原不可变发布包仅重置进程环境变量。

---

## 2. 平台共享环境变量 (Shared Agent Environment)

由管理员在全局控制台（`/settings/shared-agent-environment`）统一维护：

- **单例全局应用**：全平台所有 Agent 自动继承共享环境变量，主要用于配置团队通用的基础大模型 API Key（如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`）。
- **支持项目级覆盖**：若项目私有配置中定义了同名键，项目值会自动覆盖共享值。
- **安全存储与注入**：所有共享值均使用 `APP_SECRET_KEY` 加密保存在 PostgreSQL 中，运行时仅以 root 拥有的 `0600` 临时文件传递给进程，不泄露至宿主机命令行参数（argv）。

---

## 3. 构建阶段可见变量 (Build-visible Variables)

Eve 项目在打包（`npx eve build`）时会静态解析部分配置（例如从 `process.env` 读取 model ID）。为了保证打包一致性：

- 构建沙箱仅允许接收项目及共享环境中的普通变量（`variable`）；
- 机密变量（`secret`）**严禁传入构建沙箱**，防止不受信任的第三方依赖包通过 `postinstall` 恶意窃取密钥。

---

## 4. Agent 记忆持久化存储 (`EVELAND_MEMORY_ROOT`)

- **持久记忆契约**：Eveland 为每个 Agent 进程注入 `EVELAND_MEMORY_ROOT`，即 Agent 文件记忆所在的目录。eve 本身不读取这个变量。在 `eve dev` 之外，不带 backend 的 `fileMemory()` 没有存储后端，会直接报错；使用文件记忆的 Agent 需要传入 `eveland` SDK 提供的 backend，由它读取 `EVELAND_MEMORY_ROOT`：

  ```ts
  // agent/memory.ts
  import { defineMemory } from "eve/memory";
  import { fileMemory } from "eve/memory/file";
  import { byPrincipal } from "eve/memory/scope";
  import { evelandMemoryBackend } from "eveland/memory";

  export default defineMemory({
    scope: byPrincipal,
    provider: fileMemory({ backend: evelandMemoryBackend() }),
  });
  ```

  在 `eve dev` 下 `EVELAND_MEMORY_ROOT` 未设置，`evelandMemoryBackend()` 会让出，由 eve 自己的本地 backend 生效，因此同一份文件两处都能用。只有在实例使用 `Internal` 或 `OIDC` 身份时才按 principal 划分记忆：默认的 `Open` Provider 下所有访客共享同一个 principal。

- **租户安全隔离**：Worker 自动将该目录绑定至宿主机专属路径：`<EVELAND_DATA_DIR>/memory/<projectId>`。该路径按项目隔离且跨重新部署持久保留，项目被删除时统一清理。

## 5. Model Gateway 保留变量

- `EVELAND_MODEL_GATEWAY_KIND` 和 `EVELAND_MODEL_GATEWAY_URL` 属于平台保留层，总是存在：项目使用实例的 Model Gateway 时填入网关类型和地址，否则为空。项目或共享环境中的同名变量会被覆盖，因此项目无法把平台注入的 Provider 指向别的网关。
- key 不是保留变量：它是项目自己的 secret `AI_GATEWAY_API_KEY`，平台从不提供。完整规则见 [Model Gateway 行为契约](/zh/docs/reference/model-gateway)。

## 相关参考

- [密钥与连接配置](/zh/docs/agents/secrets-connections)：面向开发者的配置指引
- [安全模型与隔离边界](/zh/docs/operations/security)：机密落盘加密与脱敏机制

- [环境变量参考](/zh/docs/reference/environment-variables)：平台核心及运行时保留环境变量清单
