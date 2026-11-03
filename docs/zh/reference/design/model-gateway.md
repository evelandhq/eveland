---
title: Model Gateway 设计决策
description: 为什么让 Agent 保留 Vercel 风格的模型 ID，由平台在发布时注入默认 Provider，并为每个项目签发独立的网关 key。
---

> **状态：** 方向于 2026-11-03 确认，第一期已实现。行为契约以 [Model Gateway 行为契约](/zh/docs/reference/model-gateway) 为准，本页记录设计理由和考虑过的方案。

**Model Gateway** 指 Agent 调用大模型时经过的网关，例如 Vercel AI Gateway、OpenRouter、LiteLLM。它和 Eveland 自己的 [Agent Gateway](/zh/docs/reference/design/gateway) 是两回事：后者是 Agent 的入站数据面，前者是 Agent 的出站模型流量。

---

## 1. 要解决的问题

Eve Agent 写 `model: "anthropic/claude-sonnet-4.5"` 这样的字符串 ID 时，模型调用固定发往 Vercel AI Gateway。这个地址从来都改不了：我们检查了 eve 的全部 91 个 minor 版本，以及 `@ai-sdk/gateway` 1.x–4.x，`GATEWAY_BASE_URL` 一直写死为 `https://ai-gateway.vercel.sh`，SDK 只读取 `AI_GATEWAY_API_KEY`。

自托管的团队通常有自己的模型网关，用来统一管理密钥和计费、满足合规要求，或者解决国内访问的问题。于是每个 Agent 都只能在源码里自己构造 Provider，自己管 key。以公司内部的 20 个 Agent 为例：19 个用 `@ai-sdk/openai-compatible` 接内部的 New API 网关，靠 `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `MODEL_NAME` 配置；剩下一个接另一套 LiteLLM。key 怎么分配也没有统一的做法。公司计划把模型网关统一迁到 LiteLLM。

现在这种做法有几个代价：

- **源码没法搬走。** 同一份 Agent 不能直接部署到 Vercel，eve.dev 上的 Agent 也不能直接搬进 Eveland。
- **上下文窗口要手填。** eve 在构建时按模型 ID 查 Vercel 模型目录来得到上下文窗口。`MODEL_NAME` 这类自定义 ID 查不到，所以每个 Agent 都得手写 `modelContextWindowTokens`。
- **用量很可能缺失。** 只有一个 Agent 设了 `includeUsage: true`。`@ai-sdk/openai-compatible` 只有在设了这一项时才发送 `stream_options.include_usage`，所以其余 Agent 的流式调用大概率没有上报 token 用量（还需要在 UAT 上确认）。
- **没有成本数据。** eve 只从 `providerMetadata.gateway.cost` 读取成本，自建的 Provider 不会写这个字段。
- **key 归属不清。** 网关的计费、限流和日志都按 key 统计，key 一旦被多个项目共用，或者在人手之间传递，就说不清哪把 key 属于哪个项目，也没法单独吊销。

目标是：

- Agent 源码只写字符串模型 ID，同一份源码在 Vercel 和 Eveland 上都能跑。
- Eveland 管理员配置一个 Model Gateway，所有 Agent 自动使用。
- 每个项目一把 key，由平台签发和吊销，不经人手。
- 开发环境和生产环境的行为一致。

---

## 2. 决策一览

| 决策                                     | 选择                                                                                     | 放弃的方案                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 接入机制                                 | 平台在 Release 中注入一个运行时模块，设置 `globalThis.AI_SDK_DEFAULT_PROVIDER`           | 提供 `gatewayModel(name)` helper（需要改源码）；改写 Agent 源码或 manifest（违反"平台注入、不碰源码"原则） |
| 生效条件                                 | 只在管理员配置了 Model Gateway、项目没有关闭时注入；Agent 自己设了全局 Provider 时不覆盖 | 无条件接管所有模型调用                                                                                     |
| 网关 key                                 | LiteLLM：平台为每个项目签发一把 key；其他类型：实例共用一把 key                          | 所有项目始终共用一把 key；由人工给项目分配 key                                                             |
| 支持的网关                               | `vercel`、`openrouter`、`litellm`、`openai-compatible`                                   | 专门支持 New API（公司会迁到 LiteLLM）                                                                     |
| 模型命名                                 | 统一用 Vercel 模型目录的 `provider/model` 写法，原样转发给网关；别名在网关上配           | 在 Eveland 里维护一张别名表                                                                                |
| 成本                                     | 把网关返回的成本写进 `providerMetadata.gateway.cost`                                     | 由 observer 另外抓取成本                                                                                   |
| 代码位置                                 | 运行时模块放在 `eveland` 包里（`eveland/model-gateway`），Worker 把它打包进 Release      | 新建一个只能由平台注入的包                                                                                 |
| eve 的 `anthropic()` / `openai()` helper | 不设置 `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`                                          | 同时设置这两个变量，把 helper 也导向网关                                                                   |
| CLI                                      | 第二期再做 `eveland models`                                                              | 第一期就做                                                                                                 |

---

## 3. 接入机制：`AI_SDK_DEFAULT_PROVIDER`

`AI_SDK_DEFAULT_PROVIDER` 是 AI SDK 的公开机制，不是 eve 的内部实现。eve 解析字符串模型的方式是 `(globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway).languageModel(id)`。所以只要在第一次模型调用之前设置好这个全局变量，字符串 ID 就会走我们指定的 Provider。

- **只影响字符串 ID。** Agent 传入的模型对象（例如现在那 19 个 `createOpenAICompatible(...)` Agent）完全不受影响。
- **Agent 自己的设置优先。** 注入的模块发现全局变量已经有值，就什么都不做。
- **只能在运行时设置。** 静态字符串模型的 `agent.ts` 只在编译期执行，所以这个全局变量必须由运行时模块（instrumentation）来设置。
- **`eve dev` 从 1.0.0-rc.2 起支持。** 在这之前（从 0.57.0 开始），`eve dev` 会把字符串 ID 直接转成本地 `/login` 的 Vercel Gateway 模型，跳过这个全局变量。我们提了 [vercel/eve#5787](https://github.com/vercel/eve/issues/5787)，修复 [#5789](https://github.com/vercel/eve/pull/5789) 随 `1.0.0-rc.2` 发布。

**放弃 helper 方案的原因：** 每个 Agent 都要改成 `gatewayModel("...")`，源码就和 Eveland 绑死了。我们要的恰恰是 eve.dev 上的 Agent 不用改就能部署。

**不设置 `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` 的原因：**

- 内部 Agent 已经用 `OPENAI_*` 表达各自的含义，平台再注入就会和项目变量争优先级。
- eve 的这两个 helper 不接受带 `/` 的模型 ID。
- `openai()` 走的是 Responses API，各个网关对它的支持参差不齐。
- 走这条路拿不到成本。

---

## 4. 支持哪些网关

第一期内置四种类型（`kind`）：

| kind                | 协议                         | 模型 ID                   | 成本来源                                                                       | 按项目签发 key                     |
| ------------------- | ---------------------------- | ------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| `vercel`            | Vercel AI Gateway 原生协议   | Vercel slug               | 原生 `providerMetadata.gateway.cost`                                           | 否（地址不可配，只填一把 API key） |
| `openrouter`        | OpenAI 兼容 Chat Completions | 大多数与 Vercel slug 相同 | 响应体 `usage.cost`（流式在最后一个 chunk）                                    | 第二期（provisioning keys）        |
| `litellm`           | OpenAI 兼容 Chat Completions | 网关上配的 `model_name`   | 流式：最后一个 chunk 的 `usage.cost`；非流式：响应头 `x-litellm-response-cost` | 是（第 6 节）                      |
| `openai-compatible` | OpenAI 兼容 Chat Completions | 原样转发                  | 无                                                                             | 否                                 |

LiteLLM 是第一期的重点：它是公司的迁移目标，也是唯一同时提供签发接口和成本的自托管网关。文档要提醒避开 PyPI 上被投毒的 1.82.7 和 1.82.8（2026-03-24）。

其余网关的处理：

- **New API 不专门支持。** 需要时可以按 `openai-compatible` 接入，但没有成本，也不能按项目签发 key。
- **只写文档，按 `openai-compatible` 接入：** Cloudflare AI Gateway（OpenAI 兼容端点）、Portkey、Bifrost。
- **不需要专门集成：** Kong、Agent Router（原 Envoy AI Gateway）。它们对外就是 OpenAI 兼容端点。
- **不推荐：** Helicone，据报道已进入维护模式。
- **第一期不做：** Claude Messages 端点模式（按 Anthropic 协议而不是 OpenAI 协议调用网关）。

---

## 5. 模型命名空间

**统一使用 Vercel 模型目录的 slug**，例如 `anthropic/claude-sonnet-4.5`。理由：

- eve 构建时按这个 ID 查 Vercel 目录，得到上下文窗口。用 slug，Agent 就不用手填 `modelContextWindowTokens`。
- eve.dev 上的 Agent 本来就这么写，OpenRouter 的大多数 ID 也一样。

**ID 原样转发，别名在网关上配。** LiteLLM 把 `model_name` 设成 slug 即可。Eveland 不维护别名表，否则就会有两处映射关系需要保持一致，而且 Langfuse 等下游按 `provider` / `modelId` 归因时也会对不上。

**目录里没有的模型**（例如内部微调模型）照常可用，只是 Agent 要自己写 `modelContextWindowTokens`。

**模型目录按天缓存在 Eveland。** eve 构建时读取 `.eve/cache/model-catalog.json`：`fetchedAt` 在 5 分钟以内就直接用，否则去 `ai-gateway.vercel.sh` 重新取，取失败时退回旧缓存。Eveland 的 Worker 每天取一次目录，存在数据目录里，取失败就继续用旧的那份；每次构建前把它写进 Release 的 `.eve/cache/model-catalog.json`，`fetchedAt` 填写入时刻，所以构建期间 eve 不会联网。目录的真实获取时间写进构建日志。这样构建不再依赖访问 Vercel，在国内网络下也稳定。这依赖 eve 的内部缓存格式，由兼容性测试锁住；格式一旦变化，eve 会忽略这个文件、自己去取，退回到原来的行为，构建不会因此失败。

**部署时校验。** Worker 从 eve 的编译产物（`compiled-agent-manifest.json` 里根 Agent 和各子 Agent 的 `config.model.id`）读出静态模型 ID。eve 的 `agent-summary.json` 只记录根 Agent 的模型，所以不用它，用这个项目的 key 请求 `GET /v1/models`：

- 网关明确返回了模型列表，但其中没有这个 ID：部署失败，日志给出可执行的诊断，并列出相近的 ID。
- 列表接口不可用（报错或超时）：部署日志写 `WARNING`，部署继续。

用项目自己的 key 去查，校验的就是"这个项目能不能调用这个模型"，网关上按 key 限制的模型范围也一并生效。

这条与"Fail closed"原则不完全一致，是有意的取舍：模型列表只是一份参考，不是 Eveland 能证明的合规事实，而且真正调用模型时如果失败，错误会明确暴露出来。网关临时故障不应该卡住所有部署。动态选择的模型无法静态校验，不在校验范围内。

---

## 6. 配置、key 与注入

### 6.1 实例配置

**实例级配置，只有一份**，与 Shared Agent Environment 一样。配置页在 System 设置下的 `/settings/model-gateway`，只有 admin 能修改：

- `kind`；
- Base URL（`vercel` 类型不填）；
- 凭据，按类型含义不同：
  - `litellm`：**管理凭据**，只给 API 和 Worker 用来签发、轮换、吊销项目 key，**绝不下发给 Agent**；
  - 其他类型：**共享 key**，下发给所有使用平台网关的项目；
- "测试连接"按钮：`litellm` 用管理凭据请求 `/key/info` 确认凭据可用，其他类型请求 `/v1/models`；只显示成功与否。

凭据以 secret 形式存储，用 `APP_SECRET_KEY` 加密，保存后永不返回浏览器。成员只能看到是否已配置。

### 6.2 项目设置

Project Settings 增加 Model Gateway 区块，三选一：

- **使用平台签发的 key**（默认）。对不支持签发的类型，就是使用实例共享 key。
- **使用项目自己的 key**：填一个 secret，规则与其他项目 secret 相同。用于例外情况，例如某个项目在网关上有单独申请的 key。网关地址仍然由实例决定，项目只能换 key。
- **不使用平台 Model Gateway**：这个项目的部署不注入。适用于自带 `AI_GATEWAY_API_KEY` 或者直接连厂商的项目。

我们选择显式选项，而不是靠猜测项目变量来决定。

### 6.3 LiteLLM 按项目签发 key

以下行为基于 LiteLLM 的 `/key/generate`、`/key/info`、`/key/{key}/regenerate`、`/key/delete` 接口（已对照 LiteLLM 主干源码核实）：

- **何时签发。** 项目第一次以"平台签发"方式部署时，Worker 在启动进程之前签发。之后的部署、预览部署和重启都用同一把 key。
- **崩溃安全的签发流程。** LiteLLM 只存 key 的哈希，签发后丢了就再也拿不回来；`key_alias` 在整个网关内唯一，重复会返回 400。所以签发流程是：
  1. Eveland 在本地生成 key 值（`sk-` 前缀加随机串）；
  2. 先把它加密写进数据库；
  3. 再调用 `/key/generate`，传入这个 `key`，以及 `key_alias: eveland-<projectId>` 和 `metadata`（记录 Eveland 实例和项目 id）。

  重试时如果 alias 已存在，就用本地保存的 key 调 `/key/info`：能查到，说明上次已经成功；查不到，说明 alias 被别的 key 占用了，部署失败并给出诊断。

- **签发失败时部署失败。** 不回退到共享 key，否则隔离就形同虚设。
- **轮换。** 项目设置里提供"轮换 key"：先在本地生成新 key 值并保存，再调用 `/key/{key}/regenerate`，传入 `new_key` 和 `grace_period`，然后重启在线部署。旧 key 在宽限期内仍然有效，所以重启期间不会中断。
- **吊销。** 删除项目时，用 `/key/delete` 按 `key_aliases` 吊销。失败会随删除任务一起重试。
- **预算和限流由网关管。** Eveland 第一期不设置 `max_budget`、`models` 等限制，管理员按 alias 在 LiteLLM 后台调整。
- **切换或移除网关。** 管理员改了网关地址、类型或移除网关后，已签发的 key 全部作废，项目在下次启动时在新网关上重新签发。旧网关上的 `eveland-*` key 不会自动吊销：保存新配置时旧的管理凭据已经被替换，Eveland 无法再访问旧网关。删除项目时如果遇到这种 key，删除日志会写 `WARNING` 并给出别名，由管理员到旧网关上手动清理。

### 6.4 运行时下发

在保留变量层（`RESERVED_RUNTIME_ENVIRONMENT_SOURCES`）里增加三个变量：

- `EVELAND_MODEL_GATEWAY_KIND`；
- `EVELAND_MODEL_GATEWAY_URL`；
- `EVELAND_MODEL_GATEWAY_KEY`：secret，经 root 所有、权限 0600 的环境文件下发。它的值按项目的选择决定：平台签发的 key、项目自己的 key，或者实例共享 key。管理凭据永远不会出现在这里。

项目选择"不使用"或者实例未配置时，这三个变量都不出现。它们不进入构建：构建环境本来就拿不到 secret，保留名也会从构建环境里剔除。

**改了配置就重启。** 修改 Model Gateway 配置、项目选项或轮换 key，都会为相关的 `running` / `draining` 部署排队重启。重启沿用原来的 Release，与 Shared Agent Environment 的行为一致。

### 6.5 运行时模块与注入

**运行时模块 `eveland/model-gateway`。** 模块加载时依次判断：

1. 没有 `EVELAND_MODEL_GATEWAY_KIND`：什么都不做。
2. `globalThis.AI_SDK_DEFAULT_PROVIDER` 已有值：什么都不做，Agent 自己的设置优先。
3. 否则安装 Provider：
   - `vercel`：`createGateway({ apiKey })`；
   - 其他类型：`createOpenAICompatible({ name: kind, baseURL, apiKey, includeUsage: true, ... })`，再套上成本 shim（见第 7 节）。

模块把模型 ID 原样传给网关，Provider 名就是 `kind`。

**发布时注入。** Worker 在每个 eve 1.0.x 的 Release 里写入 `agent/instrumentation/eveland-model-gateway.js`，在 instrumentation 的 `setup` 里安装 Provider。`setup` 在所有 instrumentation 模块加载完之后、第一个事件之前运行，所以 Agent 在模块顶层设置的全局 Provider 一定先生效。如果用户已经写了同名文件，构建失败，与 observer 的保留文件处理方式相同。模块的代码由 Worker 打包进 Release（`.eveland/model-gateway/runtime.mjs`），不像 observer 那样从平台挂载目录加载。原因是 observer 只做观测，跟着平台版本走没有问题；而 Provider 决定了模型调用本身的行为，应该和 Release 一起固定下来（不可变产物原则）。只有配置（环境变量）是运行时注入的。

模块总是注入，但未配置时不起作用。所以先部署、后配置 Model Gateway 也不需要重新构建，重启即可生效。

**依赖方向。** 运行时模块的源码放在 `packages/eveland/src/model-gateway.ts`，既作为 SDK 的子路径发布，也是 Worker 打包的唯一来源。Worker 按文件路径打包这份源码，不 import 它（workspace 里从不构建 SDK 的 `dist/`）；架构测试固定了只有 Worker 可以声明对 `eveland` 的依赖，并写明了理由。`eveland` 包本身仍然不依赖任何 workspace 包。签发 key 的 LiteLLM 客户端只在 API 和 Worker 里，不进入 `eveland` 包。

**eve 版本。** 只为 eve 1.0.x 的 Release 注入。0.83.x 的 Release 不注入，部署日志写 `WARNING`，说明这次部署会按源码原样调用模型。0.83 很快就会退出兼容窗口。

---

## 7. 用量与成本

- **`includeUsage: true` 始终开启。** 流式调用会带上 `stream_options.include_usage`，token 用量能正常上报。
- **成本 shim。** 把网关返回的美元成本写进 `providerMetadata.gateway.cost`。eve 的 `extractGatewayCostUsd` 会读出它，进入 `usage.recorded` 的 `costUsd`，再由 Eveland 的用量投影读取。各类型的来源：
  - `openrouter` 和 `litellm`（流式）：用 `@ai-sdk/openai-compatible` 的 `metadataExtractor`，从最后一个 chunk 的 `usage.cost` 读取。LiteLLM 的流式响应在用量产生之前就已经发出响应头，所以流式下只能从响应体取成本；
  - `openrouter`（非流式）：从响应体的 `usage.cost` 读取；
  - `litellm`（非流式）：用 `wrapLanguageModel` middleware 读响应头 `x-litellm-response-cost`；
  - `openai-compatible`：没有成本来源，成本记为缺失。

  这符合现有约定：缺失就是缺失，绝不按公开价目表估算。

- **为什么不用 observer 抓取。** 写在 eve 读取的位置，eve 自己的 trace（`gen_ai.usage.cost`）、Eveland 的 Usage 页面以及外部观测平台看到的就是同一个数字，只有一条数据路径。代价是依赖 eve 的一个内部键名，由兼容性测试锁住（见第 9 节）。
- **模型归因不变。** `provider` 为 `<kind>.chat`，`modelId` 为原样的 slug，Usage 页面的模型归因规则不需要改。
- **两边的账能对上。** 每个项目一把 key，LiteLLM 后台按 alias `eveland-<projectId>` 统计的花费，与 Eveland 项目 Usage 页面的成本应当一致，可以互相核对。

---

## 8. 开发与生产一致

| 模式                    | 本地怎么用                                                                                                                               | 需要什么         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| A：用自己的 Vercel 账号 | `eve dev`，`/login` 连 Vercel                                                                                                            | 什么都不用配     |
| B：本地连非 Vercel 网关 | `eve dev`，在 Agent 里加一个 instrumentation 文件：`import "eveland/model-gateway";`，并在 `.env.local` 里设置 `EVELAND_MODEL_GATEWAY_*` | eve ≥ 1.0.0-rc.2 |
| C：公司发的开发 key     | 同 B，用 LiteLLM 上为开发者单独开的 key                                                                                                  | 同 B             |

开发用的 key 不是平台为项目签发的那把。项目 key 只存在于部署的运行时环境里，不发给开发者。

到了生产环境，Agent 自己的 instrumentation 和平台注入的是同一个模块，读的是同一组变量，行为完全一样。哪个先加载都没有关系：先加载的那个安装 Provider，后加载的那个看到全局变量已有值，就什么都不做。

平台注入的文件在 `setup` 里安装 Provider，晚于所有模块的顶层代码，所以 Agent 不论用直接赋值还是 `??=` 设置全局变量，都会先于平台生效。这一点在 eve 1.0.0-rc.2 的 `eve start` 和 `eve dev` 下都实测过。

---

## 9. 依赖的 eve 行为与兼容性测试

这套设计依赖 eve 的以下行为，都要加进 eve 兼容性矩阵，每次扩大兼容窗口时验证：

1. `eve start` 运行时通过 `AI_SDK_DEFAULT_PROVIDER` 解析字符串 ID。
2. `eve dev` 同样遵守这个全局变量（≥ 1.0.0-rc.2）。
3. 成本从 `providerMetadata.gateway.cost` 读取。
4. instrumentation 的 `setup` 在所有 instrumentation 模块加载完之后、第一次模型调用之前运行。
5. 构建从 `.eve/cache/model-catalog.json` 读取模型目录（`kind: "eve-model-catalog-cache"`，`version: 2`），`fetchedAt` 在 5 分钟以内就不再联网。

兼容窗口的验证点需要从 `1.0.0-rc.1` 推进到 `1.0.0-rc.2`，starter 模板也一并升级。

---

## 10. 安全

- **密钥只进不出。** 管理凭据、共享 key 和项目 key 都是 secret：加密存储，不进入构建、日志、遥测或任何返回给客户端的内容；诊断页面只显示是否已配置。项目 key 只在进程启动时解密，经 0600 环境文件下发。
- **管理凭据只在平台内部。** 它能签发和吊销任意 key，权限很大，所以只有 API 和 Worker 使用，永远不下发给 Agent，也不出现在任何部署的环境里。应当使用 LiteLLM 上权限最小、但能管理 key 的凭据，而不是 master key；LiteLLM 具体支持到什么粒度待验证。
- **项目 key 泄露只影响一个项目。** Agent 进程能读到自己项目的 key，这和所有运行时 secret 一样无法避免。但一把 key 只属于一个项目，泄露后轮换即可，不影响其他项目。使用 `vercel`、`openai-compatible` 等不能签发的类型时，所有项目仍然共用一把 key，这个风险在文档里写明。
- **测试连接的约束。** 由 API 发起，只有 admin 能触发，设有超时，不跟随重定向，不回显响应体。

---

## 11. 产品约定的变更

- **原约定：** 平台从不改变 Agent 的模型选择。
- **新约定：** 管理员配置了 Model Gateway、项目没有关闭时，平台为字符串模型 ID 提供默认 Provider，并在网关支持时为每个项目签发独立的 key。平台不覆盖 Agent 自己安装的 Provider，不影响模型对象，也不改写模型 ID。
- **配套修改：** `spec.md` 第 5 节"平台注入、不碰源码"原则的注入对象里加上 Model Gateway 默认 Provider，并新增一节 Model Gateway 的产品约定。

---

## 12. 分期与待验证

**第一期：**

- 配置页、项目选项、保留变量、运行时模块（四种 kind）；
- LiteLLM 按项目签发、轮换、吊销 key；
- `includeUsage`、成本 shim（openrouter、litellm）；
- 模型目录按天缓存；
- 部署时校验；
- eve 兼容性测试；
- 中英文文档。

**第二期：**

- OpenRouter 按项目签发 key（provisioning keys）；
- `eveland models` CLI（在 `apps/api/src/cli-auth.ts` 中增加 scope）；
- 在 Eveland 里为项目设置预算和模型范围（写到 LiteLLM key 上）；
- Claude Messages 端点模式。

**不做：** 专门支持 New API；Eveland 侧的别名表；Helicone。

**待验证：**

- LiteLLM 从哪个版本开始在流式最后一个 chunk 里返回 `usage.cost`，非流式响应体里是否也有 `usage.cost`。由此确定文档要求的最低版本。
- LiteLLM 上能管理 key、但权限小于 master key 的凭据怎么配。
- LiteLLM 的 `/v1/models` 是否只返回该 key 能调用的模型。
- OpenRouter 是否默认在响应里返回 `usage.cost`。
- 那 19 个现有 Agent 在 UAT 上的用量覆盖率。这个问题与本设计无关，可以先单独修。

**内部 Agent 的迁移，跟着公司迁 LiteLLM 一起做。** 一个 Agent 要迁移，就改成字符串 slug，删掉 `createOpenAICompatible`、`MODEL_NAME` 和项目里的 `OPENAI_*` 变量；如果 slug 在 Vercel 目录里，`modelContextWindowTokens` 也可以删掉。迁移后 key 由平台签发，`modelId` 从原来的 `MODEL_NAME` 变成 slug，按模型名计算成本的 Langfuse 配置要同步调整；`eve-dev-skill` 里的规则也要一起改。

## 相关参考

- [Agent 环境与变量层级](/zh/docs/reference/agent-environment)：保留变量层、Shared Agent Environment 与构建可见变量
- [Eve 兼容性窗口](/zh/docs/reference/eve-compatibility)：支持的 eve 版本与兼容性矩阵
- [可观测性](/zh/docs/reference/observability)：用量与成本的采集路径
