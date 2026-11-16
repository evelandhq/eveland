---
title: Eve 兼容性
description: Eveland 托管哪些 Eve 版本、项目如何声明 Eve，以及版本窗口如何执行。
---

Eveland 托管 Eve `>=1.0.0 <1.1.0`，已验证版本为 `1.0.0`。整个 1.x 期间下限固定为 `1.0.0`；验证新的 Minor 只会提高上限，所以构建时在窗口内的 Release 会一直留在窗口内。即使 Eve 在 1.x 内保持稳定 API 兼容，新的 Eve Minor 也要等 Eveland 审阅并对它重跑兼容性测试之后才会被托管。

## 声明 Eve

在项目 `package.json` 的 `dependencies`（或 `devDependencies`）中声明 `eve`，可以使用任何能解析到窗口内的 npm 范围。`eve init` 生成的 `"^1.0.0"` 可以直接使用，`"~1.0.0"`、`"1.0.0"`、`"1.x"` 也都可以。无法解析到窗口内的范围（`"0.83.3"`、`"1.0.0-rc.2"`、`"^2.0.0"`）以及不是版本范围的写法（`"latest"`、git URL、`workspace:`）会被拒绝。

请提交 lockfile。`^1.0.0` 这样的范围会在构建时解析到最新的匹配版本；一旦 Eve 发布了 Eveland 尚未验证的 Minor，没有 lockfile 的构建就会安装它并失败。如果希望没有 lockfile 的构建也停留在已验证的 Minor，请改用 `~1.0.0`。

## 执行

- **导入与预检。** 声明的版本必须能解析到窗口内。`eveland deploy` CLI 在上传之前，会用实例在 `GET /api/instance` 返回的范围（`eve.supportedRange`）在本地做同样的检查。
- **构建。** 构建会读取实际安装的 Eve 版本（`node_modules/eve`）。如果它在窗口外或无法读取，构建失败，不会记录 Release。安装的版本会记录在 Release 上，并显示在 Dashboard 中。

构建之后不再重复检查版本：每个 Release 在构建时就保证在窗口内。

## 版本配对

| 组件                                 | 版本                                |
| ------------------------------------ | ----------------------------------- |
| Agent 项目中的 Eve                   | `>=1.0.0 <1.1.0`，已验证 `1.0.0`    |
| Agent 项目中的 `eveland` SDK         | peer 依赖 `eve >=1.0.0 <2.0.0`      |
| 注入每个新 Release 的 Workflow World | `@evelandhq/workflow-world@1.0.0`   |
| Worker 运行的沙箱                    | `@evelandhq/sandbox-bwrap` `^1.0.0` |

## 协议基线

下表是 Eveland 读取的 Eve 表面。架构测试会针对安装的 Eve 断言这些值，所以提高上限时会重跑它们。

| 表面                             | 值                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| Session 流                       | v27（`x-eve-stream-version: 27`）；Playground 打包读取它的 `eve/client`，Agent Gateway 原样转发该流 |
| Discovery Manifest               | 16，只在构建前为 Extension 挂载读取；构建摘要读 `eve info --json`                                   |
| Workflow 存储                    | 默认 spec 9（单 Orchestrator）；Deployment 设置 `WORKFLOW_SEALED_LOG=0` 时为 6                      |
| Eve 依赖的 Workflow World 能力   | `atomicStartHook`、`deploymentAffinity`、`hookForceClaim` 加上处于 active 的 `hookRetention`        |
| OpenTelemetry Agent Trace Schema | 4                                                                                                   |

面向 Agent 作者的说明：

- `localDev()` 在 `eve start` 下不放行任何请求；已部署的 Agent 请使用 `evelandIdentity()`、`httpBasic()` 或 OIDC 认证。
- Eveland 会向每个 Release 注入 bwrap 沙箱。作者编写的沙箱模块保留其 `prepare` 和选择器，但每个内置 Provider 都会构建 bwrap 环境，因此镜像、Dockerfile 等 Provider 专属选项会被忽略。
- `chatgpt()` 模型只能在本地使用：部署环境中没有 Codex 登录。请使用 AI Gateway 或服务端认证的模型。
- 预构建的 Extension 必须针对 Eve 1.x 构建。
- Eveland 为它运行的每次构建和每个 Deployment 设置 `EVE_TELEMETRY_DISABLED`。

## Model Gateway 依赖的行为

[Model Gateway](/zh/docs/reference/model-gateway) 依赖一些 Eve API 并未承诺的行为，所以提高上限时还要对真实安装重跑 `pnpm --filter @evelandhq/worker smoke:model-gateway`（把 `EVE_VERSION` 设为候选版本）：

- `eve build` 信任预先写入、`fetchedAt` 不超过五分钟的 `.eve/cache/model-catalog.json`（`kind: "eve-model-catalog-cache"`，`version: 2`）；
- instrumentation 的 `setup` 在所有 instrumentation 模块加载完之后运行，`eve start` 和 `eve dev` 通过 `globalThis.AI_SDK_DEFAULT_PROVIDER` 解析字符串模型 ID；
- Eve 把 `providerMetadata.gateway.cost` 记录为 `usage.recorded` 的 `costUsd`。

## 深入参考

- [已知限制](/zh/docs/reference/known-limitations)：Eveland 不支持的 Eve 功能
- [源码导入](/zh/docs/reference/source-import)：预检验证与依赖扫描
- [部署第一个 Agent](/zh/docs/agents/first-deployment)：项目导入与构建快速上手
- [升级与回滚](/zh/docs/operations/upgrades)：平台更新与 Eve 依赖生命周期
