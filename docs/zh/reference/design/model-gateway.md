---
title: Model Gateway 设计决策
description: 为什么让 Agent 保留 Vercel 风格的模型 ID，由平台在发布时注入默认 Provider，以及为什么每个项目用自己的 AI_GATEWAY_API_KEY。
---

行为契约以 [Model Gateway 行为契约](/zh/docs/reference/model-gateway) 为准，本页记录其背后的考量。

**Model Gateway** 指 Agent 调用大模型时经过的网关，例如 Vercel AI Gateway、OpenRouter、LiteLLM。它和 Eveland 自己的 [Agent Gateway](/zh/docs/reference/design/gateway) 是两回事：后者是 Agent 的入站数据面，前者是 Agent 的出站模型流量。

---

## 1. 要解决的问题

Eve Agent 写字符串模型 ID（如 `model: "anthropic/claude-sonnet-4.5"`）时，调用会发往 Vercel AI Gateway，其地址在 `@ai-sdk/gateway` 中写死为 `https://ai-gateway.vercel.sh`，SDK 只读取 `AI_GATEWAY_API_KEY`。

自托管团队通常有自己的模型网关，用来集中管理 key 和计费、满足合规要求或解决地域访问问题。没有平台支持时，每个 Agent 都要在源码里自建 Provider、自管 key，代价是：

- **可移植性。** 同一个 Agent 不能原样部署到 Vercel，eve.dev 上的 Agent 也不能原样搬进 Eveland。
- **上下文窗口。** eve 在构建时按模型 ID 去 Vercel 模型目录查上下文窗口；自定义 ID 查不到，每个 Agent 都要手写 `modelContextWindowTokens`。
- **用量与成本。** `@ai-sdk/openai-compatible` 只有在 `includeUsage: true` 时才报告流式调用的 token 用量；eve 只从 `providerMetadata.gateway.cost` 读取成本，自建 Provider 从不写这个字段。
- **key 归属。** 网关的计费、限流和日志都按 key 划分。多个项目共用的 key 无法归属到具体项目，也无法单独吊销。

目标：Agent 源码只写字符串模型 ID，在 Vercel 和 Eveland 上都原样运行；管理员配置一个 Model Gateway，所有 Agent 自动使用；每个项目在 eve 已认识的变量里使用自己的 key，并在网关上管理；开发环境与生产行为一致。

---

## 2. 决策一览

| 决策                              | 选择                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| 接入机制                          | 平台向 Release 注入一个运行时模块，设置 `globalThis.AI_SDK_DEFAULT_PROVIDER`                    |
| 何时生效                          | 仅当管理员配置了 Model Gateway 且项目没有选择关闭时；Agent 自己安装的全局 Provider 永远不被覆盖 |
| 网关 key                          | 每个项目设置自己的 `AI_GATEWAY_API_KEY`；Eveland 不持有、不签发 key，项目未设置时也不代为提供   |
| 支持的网关                        | `litellm`、`openrouter`、`vercel`、`openai-compatible`                                          |
| 模型命名                          | Vercel 目录的 `provider/model` slug，原样转发给网关；别名配置在网关上                           |
| 成本                              | 把网关报告的成本写入 `providerMetadata.gateway.cost`                                            |
| 代码位置                          | 运行时模块在 `eveland` 包里（`eveland/model-gateway`），由 Worker 打包进 Release                |
| eve 的 `anthropic()` / `openai()` | 保持原样：平台不设置 `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`                                   |

---

## 3. 接入机制：`AI_SDK_DEFAULT_PROVIDER`

`AI_SDK_DEFAULT_PROVIDER` 是 AI SDK 的公开机制，不是 eve 的内部实现。eve 解析字符串模型的方式是 `(globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway).languageModel(id)`，所以只要在第一次模型调用前设置好这个全局变量，字符串 ID 就会走平台选定的 Provider，而源码与 eve.dev 上的 Agent 写法完全相同。

- **只影响字符串 ID。** Agent 传入的模型对象不受影响。
- **Agent 自己的设置优先。** 全局变量已经有值时，注入的模块什么也不做。
- **在运行时设置。** 静态字符串模型的 `agent.ts` 只在编译时求值，所以全局变量由运行时模块（instrumentation）设置。

eve 的 `anthropic()` 和 `openai()` 保持原样：它们拒绝包含 `/` 的模型 ID，`openai()` 使用的 Responses API 各网关支持程度不一，这条路径拿不到成本，而且平台注入的 `OPENAI_*` 会与项目里同名变量争夺优先级。

---

## 4. 支持哪些网关

| kind                | 协议                         | 模型 ID                   | 成本来源                                                                       |
| ------------------- | ---------------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| `openrouter`        | OpenAI 兼容 Chat Completions | 大多与 Vercel slug 相同   | 响应体中的 `usage.cost`（流式时在最后一个 chunk）                              |
| `litellm`           | OpenAI 兼容 Chat Completions | 网关上配置的 `model_name` | 流式：最后一个 chunk 的 `usage.cost`；非流式：响应头 `x-litellm-response-cost` |
| `vercel`            | Vercel AI Gateway 原生协议   | Vercel slug               | 原生 `providerMetadata.gateway.cost`                                           |
| `openai-compatible` | OpenAI 兼容 Chat Completions | 原样转发                  | 无                                                                             |

**`vercel` 安装 Vercel AI Gateway 自己的 Provider**（`createGateway`），地址固定。把它作为一个 kind，是为了在 Vercel 和其他网关之间切换时只改 kind：所有 kind 都读同一个 `AI_GATEWAY_API_KEY`。

LiteLLM 是参考的自托管网关：它报告成本，并支持按 key 管理预算。其他提供 OpenAI 兼容 Chat Completions 端点的网关（如 Cloudflare AI Gateway、Portkey、Bifrost、Kong、Agent Router）按 `openai-compatible` 接入，没有成本数据。

---

## 5. 模型命名空间

**模型 ID 使用 Vercel 目录的 slug**，如 `anthropic/claude-sonnet-4.5`。用 slug，eve 在构建时能从目录查到上下文窗口，Agent 不必设置 `modelContextWindowTokens`；eve.dev 上的 Agent 本来就这样写，OpenRouter 的 ID 也大多相同。

**ID 原样转发，别名配置在网关上。** LiteLLM 只需把 `model_name` 设为 slug。只在网关上维护一份映射，下游按 `provider` / `modelId` 做的归属（如 Langfuse）就与 Agent 写的一致。

**不在目录里的模型**（如内部微调模型）照样可用，Agent 自己设置 `modelContextWindowTokens` 即可。

**Eveland 每天缓存一次模型目录。** eve 构建时读取 `.eve/cache/model-catalog.json`，`fetchedAt` 在 5 分钟以内就直接使用，否则重新从 `ai-gateway.vercel.sh` 拉取。Worker 每天拉取一次目录（拉取失败时保留上一份），并在每次构建前写入 Release，`fetchedAt` 设为写入时间，同时在构建日志里记录真实的拉取时间。这样构建不再依赖访问 Vercel，在访问缓慢或受阻的网络上也能稳定构建。这依赖 eve 的内部缓存格式，由兼容性测试锁定；格式一旦变化，eve 会忽略该文件自行拉取，而不是让构建失败。

**部署时校验。** 带注入 Provider 的 Release，其字符串模型会用项目自己的 key 查询网关的 `GET /v1/models` 进行校验，因此网关上按 key 的模型限制同样生效。key 被拒或模型不存在时部署失败；缺少 key 或列表接口不可用时只给出警告。这是有意偏离 fail-closed 原则：模型列表只是参考，不是 Eveland 能证明的合规事实；失败的模型调用自己会给出明确错误；网关的临时故障不应阻塞所有部署。动态选择的模型无法静态校验，不在范围内。

---

## 6. Key：项目自己的 `AI_GATEWAY_API_KEY`

**每个项目把 key 设为一个普通的项目 Secret，名为 `AI_GATEWAY_API_KEY`**，即 eve 内置 Vercel AI Gateway Provider 读取的变量。于是同一个变量的含义是“本项目字符串模型所经网关的 key”，无论那是 Vercel 还是实例的网关。eve.dev 上的 Agent 带着已有的 key 原样部署，项目切换网关只需改 key 的值，不用改名字。

- **没有兜底。** 项目没设 key，平台也不提供，调用会在网关处失败。共享的兜底 key 会把所有没设 key 的项目悄悄记到同一个 key 上，而这正是按项目分 key 要消除的模糊。
- **key 的生命周期归网关。** 管理员在网关上为每个项目创建一个 key，设定预算、限流和允许的模型，也在那里吊销。Eveland 不保存任何网关凭据，因此既不能签发，也不能扩大网关上的访问权限。
- **key 只发往已配置的网关。** 项目如果在配置了 Model Gateway 的实例上仍持有 Vercel key，这个 key 会被发往该网关并被拒绝，部署时校验会写明网关地址。网关是实例自己的，这种暴露被认为可以接受；解决办法是换 key，或让项目关闭 Model Gateway。

---

## 7. 运行时模块与其位置

**Provider 随 Release 固定。** Worker 在每个 Release 中写入 `agent/instrumentation/eveland-model-gateway.js`，并把模块代码打包进去（`.eveland/model-gateway/runtime.mjs`）。observer 从平台挂载目录加载，因为它只做观测；Provider 决定模型调用本身的行为，所以属于不可变的 Release。运行时只下发配置，即保留变量 `EVELAND_MODEL_GATEWAY_KIND` 与 `EVELAND_MODEL_GATEWAY_URL`。

**始终注入，未配置时不生效。** 部署之后再配置 Model Gateway，对带该模块的 Release 只需重启，无需重新构建。

**在 `setup` 中安装。** instrumentation 的 `setup` 在所有 instrumentation 模块加载完之后、第一个事件之前运行，所以 Agent 在模块顶层设置的全局 Provider（直接赋值或 `??=`）一定先生效并胜出。

**一份源码，两个使用方。** 模块源码是 `packages/eveland/src/model-gateway.ts`：作为 SDK 子路径发布，供本地开发使用；Worker 按文件路径把它打包进 Release。架构测试把 Worker 钉为唯一可以声明 `eveland` 依赖的包，`eveland` 包本身不依赖任何工作区包。

---

## 8. 用量与成本

- **始终开启 `includeUsage: true`**，流式调用会报告 token 用量。
- **成本写在 eve 读取的位置。** 模块把网关报告的美元成本写入 `providerMetadata.gateway.cost`，eve 把它转成 `usage.recorded` 的 `costUsd`。eve 自己的 trace（`gen_ai.usage.cost`）、Eveland 的 Usage 页面和外部可观测后端因此经由同一条数据路径看到同一个数字。网关不报告成本时保持缺失，不做估算。
- **模型归属不变。** `provider` 是 `<kind>.chat`，`modelId` 是原样的 slug。
- **两本账可以对上。** 每个项目一个 key，网关上该 key 的花费应与该项目 Usage 页上的成本一致。

---

## 9. 开发与生产一致

| 模式                      | 本地配置                                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A：自己的 Vercel 账号     | `eve dev`，通过 `/login` 连接 Vercel                                                                                                                                   |
| B：本地使用非 Vercel 网关 | `eve dev`，在 Agent 里加一个调用 `installModelGateway` 的 instrumentation 文件，并在 `.env.local` 中设置 `EVELAND_MODEL_GATEWAY_KIND` / `_URL` 与 `AI_GATEWAY_API_KEY` |

请在网关上给每位开发者单独发 key，不要使用项目部署用的 key。生产环境中，Agent 自己的 instrumentation 与平台注入的文件是同一个模块、读同样的变量；先加载的那个安装 Provider，后加载的看到全局已设置便什么也不做。

---

## 10. 安全

- **Eveland 不持有网关凭据。** 即使 Eveland 被攻破，也无法扩大网关上的访问权限。项目的 key 是普通项目 Secret：静态加密，只在进程启动时解密，经 root 所有的 `0600` 环境文件下发，在日志中脱敏，不进入构建、遥测或任何返回给客户端的内容。
- **泄露的项目 key 只影响一个项目**，在网关上轮换该 key 即可。
- **网关地址是保留变量。** 项目无法把注入的 Provider 指向别处。
- **出站请求受约束。** 部署时校验只把项目的 key 发给已配置的网关；只有管理员能执行的 Test connection 只把表单里输入的 key 发给表单中的网关，且不保存。两者都有超时、不跟随重定向，并在报错中屏蔽 key。

## 相关参考

- [Model Gateway 行为契约](/zh/docs/reference/model-gateway)：配置、项目选项、校验与重启行为
- [Agent 环境与变量层级](/zh/docs/reference/agent-environment)：保留变量层与构建可见变量
- [Eve 兼容性](/zh/docs/reference/eve-compatibility)：Model Gateway 依赖的 Eve 行为
- [可观测性](/zh/docs/reference/observability)：用量与成本的采集路径
