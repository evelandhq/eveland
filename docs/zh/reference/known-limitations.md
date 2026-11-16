---
title: 已知限制
description: Eveland 1.0 不支持的 Eve 功能与项目形态，以及与 eve 自托管服务器行为不同的地方。
---

Eveland 托管标准的单 Agent Eve 项目。本页列出它不支持的内容，以及托管后的 Agent 与同一项目在你自己的机器上用 `eve start` 运行时行为不同的地方。平台能识别的限制，会在预检或构建时以写明原因的错误拒绝项目。

## 不支持

| 功能                                                                                 | 结果                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent 文件直接放在仓库根目录（flat 布局），或在 `agents/<name>/` 下放多个 Agent      | 预检拒绝导入。请把一个 Agent 放在仓库根目录的 `agent/` 下，见[源码导入](/zh/docs/reference/source-import)。                                                     |
| 动态 schedule（`eve/experimental/schedules` 的 `defineDynamicSchedules`）            | 构建失败：`agent/schedules/` 下的每个文件都必须声明静态 `cron`。见[调度](/zh/docs/reference/scheduling)。                                                       |
| 需要安装系统软件包的扩展，例如 `@eve/agent-browser`、`agent-desktop`、`computer-use` | 它们首次使用时用 `apt`/`dnf` 加 `sudo` 安装 Chromium 或桌面工具。沙箱根文件系统只读、命令以非特权用户运行，因此安装会在运行时失败。                             |
| 由 Extension 自带、在辅助文件中构建、或来自自定义 provider 的沙箱                    | 构建失败。所有沙箱都运行在平台的 bubblewrap provider 上，见 [Agent 沙箱](/zh/docs/agents/sandbox)。                                                             |
| 单文件子 Agent（`subagents/<name>.ts`），无论属于项目还是 Extension                  | 构建失败：eve 给每个单文件子 Agent 分配自己的默认沙箱，平台没有可以替换的槽位。请改为目录式子 Agent（`subagents/<name>/agent.ts`）。                            |
| 域名级或改写请求头的沙箱网络策略                                                     | 被拒绝。沙箱网络只有 `"allow-all"`（默认）和 `"deny-all"` 两种。因此设置了 `github` 的 eve git 扩展也不可用，它需要改写请求头的网络策略。                       |
| 工具需要沙箱的 keyed `invokeTool` 调用（`toolSessions`）                             | 不支持：eve 从不结束这些沙箱，平台的 provider 也没有为它们设保留上限。                                                                                          |
| eve evals                                                                            | Eveland 没有 evals 集成。请在本地运行 `eve eval`，或用 `eve eval --url` 指向某个 Deployment 的预览 URL。                                                        |
| 平台签发的机器或服务凭据                                                             | Eveland 只为人签发 Caller Token（见[身份](/zh/docs/reference/identity)）。Agent 调用其它服务所用的凭据由你作为项目 Secret 提供。                                |
| 平台提供的文件或对象存储                                                             | 不提供。平台给 Agent 的唯一持久存储是文件记忆（`EVELAND_MEMORY_ROOT`，见 [Agent 环境](/zh/docs/reference/agent-environment)）；其它数据请使用你自己的存储服务。 |
| `chatgpt()` 模型                                                                     | 仅限本地：Deployment 内没有 Codex 登录。请使用 Model Gateway 或服务端认证的模型。                                                                               |
| 以 Docker 作为生产运行时                                                             | Docker 运行时只用于本地开发和在 macOS 上试用 Eveland。生产环境中每个 Deployment 都是一个 systemd 单元，见[运行时](/zh/docs/operations/runtime)。                |

## 与 eve 自带服务器的差异

### 沙箱命令

- `EVELAND_SANDBOX_RUN_TIMEOUT_MS`（默认 10 分钟）和 `EVELAND_SANDBOX_MAX_OUTPUT_BYTES`（默认 16 MiB）约束每一条沙箱命令，包括 Agent 用 `spawn()` 启动的长时运行进程，例如开发服务器或文件监视器。到达任一上限时，该命令的进程组会被杀掉。如果你的 Agent 运行这类进程，请让运维调高上限；它对实例上的所有 Deployment 生效。
- eve 的 `bash` 工具无法把长命令转入后台：每条命令有自己的 `/tmp`，任何进程都不会比启动它的命令活得更久。工具会等待命令结束，最长到运行超时。
- 根文件系统只读，命令以非特权用户运行，因此 `apt-get`、`sudo` 和 eve 的 `installCodeTooling` 会失败。宿主机已安装的工具可以使用，例如 `git`（包括 https）、`node`、`python3`。

### 回调 URL

- `createWebhook().url` 指向 `http://localhost:<port>`，即 Agent 进程监听的私有地址：eve 1.0 用进程监听的地址生成它，不使用公开 origin。请把公开形式的 URL 交给调用方，见 [Channel、Webhook 与回调](/zh/docs/agents/channels-webhooks#4-workflow-webhook)。
- Connection 登录链接和远程子 Agent 的回调 URL 已经以项目的公开 Agent origin 开头。

### Schedule

Schedule 由平台调度器触发，因此这些会话没有 eve 定时会话的行为：不会只投递最终回复，会话上下文里没有 `scheduleId`，也不会预先拒绝登录和审批。详见[调度：与 eve 自带调度器的差异](/zh/docs/reference/scheduling#与-eve-自带调度器的差异)。

### 用量

远程子 Agent（无论在另一个 Eveland 安装上，还是在本安装的另一个项目里）把它的花费记在它自己的项目上，调用方 Session 的用量合计不包含这部分。

### Workflow World 的选择

Eveland 在每个 Release 中注入自己的 Workflow World，把每个 workflow run 路由回启动它的 Deployment。这一注入依赖 Eve 稳定 API 之外的三个接口：实验性的 Agent 选项 `experimental.workflow.world`、`defineAgent` 结果上的内部标记 `Symbol.for("eve.defined-agent")`，以及未写入文档的 World 能力 `deploymentAffinity`。Eveland 的架构测试会针对每个经过验证的 Eve 版本检查这三项。之后的 Eve 版本可能改变它们，届时按 Deployment 的路由会失效，直到 Eveland 完成适配；这也是新的 Eve minor 必须经 Eveland 验证后才进入[兼容窗口](/zh/docs/reference/eve-compatibility)的原因之一。

## 深入参考

- [Eve 兼容性](/zh/docs/reference/eve-compatibility)：支持的 Eve 版本与窗口的执行方式
- [Agent 沙箱](/zh/docs/agents/sandbox)：沙箱命令能做什么，以及安全边界
- [Channel、Webhook 与回调](/zh/docs/agents/channels-webhooks)：入站流量与回调使用的公开 URL
