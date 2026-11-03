---
title: Model Gateway 行为契约
description: 平台如何用每个项目自己的 AI_GATEWAY_API_KEY，把 Agent 的字符串模型 ID 接到实例的模型网关，以及用量、成本和部署时校验的规则。
---

**Model Gateway** 是 Agent 调用大模型时经过的网关。管理员为整个实例配置一个，所有项目默认使用。它和 Eveland 的 [Agent Gateway](/zh/docs/reference/routing) 是两回事：后者处理 Agent 的入站流量，前者承载 Agent 的出站模型调用。设计理由见 [Model Gateway 设计决策](/zh/docs/reference/design/model-gateway)。

---

## 1. 支持的网关

| 类型              | 管理员填写什么            | 成本                       |
| ----------------- | ------------------------- | -------------------------- |
| LiteLLM           | Base URL（以 `/v1` 结尾） | 记录 LiteLLM 报告的成本    |
| OpenRouter        | Base URL                  | 记录 OpenRouter 报告的成本 |
| Vercel AI Gateway | 无（地址固定）            | Vercel AI Gateway 原生成本 |
| OpenAI-compatible | Base URL                  | 不记录（缺失）             |

其他提供 OpenAI 兼容 Chat Completions 端点的网关（Cloudflare AI Gateway、Portkey、Bifrost、Kong、Agent Router、New API 等）按 OpenAI-compatible 接入。LiteLLM 请避开 PyPI 上被投毒的 1.82.7 和 1.82.8。

所有类型读的都是同一个 `AI_GATEWAY_API_KEY`（§3），所以在 Vercel AI Gateway 和其他网关之间切换，只需要改类型和各项目 key 的值，不用改变量名。

---

## 2. 作用范围

- **只影响字符串模型 ID。** Agent 写 `model: "anthropic/claude-sonnet-4.5"` 这样的字符串时，调用经过 Model Gateway；Agent 自己传入的模型对象（例如用 `createOpenAICompatible(...)` 或 AI SDK 的 `gateway(...)` 构造的）不受影响，照常调用它自己的 provider。
- **Agent 自己的 provider 优先。** Agent 在自己的 instrumentation 里设置了 `globalThis.AI_SDK_DEFAULT_PROVIDER`，平台不会替换它。
- **模型 ID 原样转发。** Eveland 不改写模型 ID，也不维护别名表；别名在网关上配置（例如 LiteLLM 的 `model_name`）。推荐使用 Vercel 模型目录里的 slug，这样 eve 构建时能查到上下文窗口，Agent 不必自己写 `modelContextWindowTokens`。
- **只作用于 eve 1.0 及以上的 Release。** eve 0.83 的 Release 照常构建，构建日志里会有一条 `WARNING`，不做网关检查（§7），模型调用保持 Agent 原本的写法。
- **未配置时什么都不做。** 平台总是把 provider 模块注入 eve 1.0 的 Release，但实例没有配置网关、或者项目选择不用时，它不做任何事。所以部署之后再配置网关，只需要重启，不需要重新构建。
- **没有 provider 的 Release 需要重新部署。** 平台开始注入 provider 之前构建的 Release，以及 eve 0.83 的 Release，里面都没有 provider，而重启沿用的还是同一个 Release。网关变更时不会重启这类部署；只要项目设为使用网关，设置页就会把它列为“仍按原写法调用模型”，直到在 eve 1.0 及以上重新部署。

---

## 3. Key：每个项目自己的 `AI_GATEWAY_API_KEY`

- **Eveland 不持有网关的 key，也不签发 key。** 每个项目在 Variables and secrets 里自己设置名为 `AI_GATEWAY_API_KEY` 的 secret，和 eve 自带的 Vercel AI Gateway provider 读的是同一个变量。项目用哪个网关，这个变量就是哪个网关的 key。
- **key 的生命周期归网关管理。** 在网关自己的管理后台为每个项目建一把 key（LiteLLM 上可同时设置预算、限流和允许的模型），设到项目上，轮换和吊销也在网关那边做。修改项目的 secret 会重启它的在线部署，和其他环境变量变更一样。
- **没设就是没设，没有兜底。** 项目没有 `AI_GATEWAY_API_KEY` 时，平台不提供任何替代：模型调用不带 key 发到网关，在网关那里失败。部署时检查（§7）会在构建日志里写一条 `WARNING`。
- **key 发往配置的网关。** 配置了 Model Gateway 时，项目的 `AI_GATEWAY_API_KEY` 会发给这个网关。从 Vercel 迁过来、带着 Vercel AI Gateway key 的项目，应换成网关的 key，或者把项目设为“关闭”（§5）；否则这把 key 会被发到实例的网关，被拒绝后部署失败（§7）。

---

## 4. 实例配置（`/settings/model-gateway`）

- 只有管理员能查看和修改。
- 配置的内容是网关类型和 Base URL（Vercel AI Gateway 不需要）。带凭据的 Base URL（`user:password@`）会被拒绝。
- **测试连接**：在表单的测试 key 输入框里填一把该网关上的 key，API 用它列一次网关的模型，返回模型数量或错误信息。这把 key 不保存；请求不跟随重定向、设有超时，错误信息里会打码。
- 保存一个不同的网关或移除网关时，平台为所有使用它的项目（即没有设为“关闭”的项目）的在线部署排队重启，沿用现有 Release。Release 里没有 provider 的在线部署（§2）不会重启；保存后页面会列出需要重新部署的项目。

---

## 5. 项目选项（项目设置 → Model Gateway）

| 选项                       | 行为                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| 使用 Model Gateway（默认） | 字符串模型 ID 带着项目的 `AI_GATEWAY_API_KEY` 发往实例的网关。                                   |
| 关闭                       | 不注入任何东西，Agent 按原本的写法调用模型（有 `AI_GATEWAY_API_KEY` 时就是 Vercel AI Gateway）。 |

修改选项会为该项目里带 provider 的在线部署排队重启。项目使用网关期间，页面会把 Release 里没有 provider 的在线部署（§2）列为需要重新部署。

---

## 6. 运行时契约

平台向每个 eve 1.0 的 Release 写入：

- `agent/instrumentation/eveland-model-gateway.js`：一个 instrumentation 文件，在 `setup` 里安装 provider。`setup` 在所有 instrumentation 模块加载完之后、第一个事件之前执行，所以 Agent 在模块顶层设置的全局 provider 总是先就位。源码里已有同名文件（任意扩展名）时，构建失败。
- `.eveland/model-gateway/runtime.mjs`：打包好的 provider 代码，随 Release 固定。

网关在哪里，通过两个**平台保留变量**传入（项目里的同名条目会被覆盖）：

| 变量                         | 内容                                               |
| ---------------------------- | -------------------------------------------------- |
| `EVELAND_MODEL_GATEWAY_KIND` | 网关类型；项目不使用网关时为空                     |
| `EVELAND_MODEL_GATEWAY_URL`  | Base URL；Vercel AI Gateway 或项目不使用网关时为空 |

key 是项目自己的 `AI_GATEWAY_API_KEY`，不是保留变量。

这个 provider：

- 把 `AI_GATEWAY_API_KEY` 作为 Bearer token 发送；未设置时完全不带 `Authorization` 头；
- 总是发送 `stream_options.include_usage`，流式调用也能拿到 token 用量；
- 把网关报告的美元成本写进 `providerMetadata.gateway.cost`，eve 会把它记为 `usage.recorded` 里的 `costUsd`。OpenRouter 和 LiteLLM 在响应体的 `usage.cost` 里报告成本（流式时在最后一个 chunk 里）；LiteLLM 的非流式响应没有这个字段时，改用 `x-litellm-response-cost` 响应头。没有成本来源时成本保持缺失，绝不估算；
- 配置无效时（未知类型、Base URL 不是 http(s)）让进程启动失败，错误信息只写变量名，不写变量值。

---

## 7. 部署时检查

构建出带 provider 的 Release 后，Worker 从 eve 的编译产物（`.output/.eve/compile/compiled-agent-manifest.json`）读出所有以字符串写的模型 ID：根 Agent 和每个子 Agent（包括嵌套的）的 `model` 与 `compaction.model`，再用**这个项目的 `AI_GATEWAY_API_KEY`** 向网关列出模型。每条日志都写明网关地址。

| 情况                              | 结果                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 网关拒绝了这把 key（HTTP 401）    | 部署失败：`ERROR: the Model Gateway at <url> rejected this project's AI_GATEWAY_API_KEY`，丢弃这个 Release。 |
| 列表里缺少某个 ID                 | 部署失败，`ERROR` 里给出最接近的可用 ID，丢弃这个 Release。                                                  |
| 项目没有设置 `AI_GATEWAY_API_KEY` | 构建日志写一条 `WARNING`，部署继续，模型调用会在网关那里失败。                                               |
| 列表接口因其他原因不可用          | 构建日志写一条 `WARNING`，部署继续。                                                                         |

模型对象不检查，因为它们不经过网关；eve 0.83 的 Release 同理不检查。动态选择的模型无法静态检查，不在范围内。

---

## 8. 模型目录缓存

eve 构建时按模型 ID 在 Vercel AI Gateway 的模型目录里查上下文窗口。Worker 把目录缓存在 `<EVELAND_DATA_DIR>/cache/model-catalog.json`，每天最多取一次，取失败时保留上一份。每次构建前，Worker 把目录写进 Release 的 `.eve/cache/model-catalog.json`，eve 构建时就不再自己去取。构建日志会记录目录的获取时间。这对每个 eve 1.0 的构建都生效，不论是否配置了 Model Gateway。

---

## 9. 本地开发

默认情况下，`eve dev` 通过 `/login` 连接开发者自己的 Vercel 账号，不需要任何配置。要在本地使用同一个非 Vercel 网关（需要 eve ≥ 1.0.0-rc.2）：

```ts title="agent/instrumentation/model-gateway.ts"
import { defineInstrumentation } from "eve/instrumentation";
import { installModelGateway } from "eveland/model-gateway";

export default defineInstrumentation({
  setup() {
    installModelGateway();
  },
});
```

把 `eveland` 加为依赖，再在 `.env.local` 里设置 `EVELAND_MODEL_GATEWAY_KIND`、`EVELAND_MODEL_GATEWAY_URL` 和 `AI_GATEWAY_API_KEY`，用为开发者单独开的 key，不要用项目部署用的 key。部署到 Eveland 后，这个文件和平台注入的是同一个模块，读同样的变量；先执行的那个安装 provider，另一个什么都不做。

## 延伸阅读

- [Model Gateway 设计决策](/zh/docs/reference/design/model-gateway)：为什么这样设计
- [Agent 环境与变量层级](/zh/docs/reference/agent-environment)：保留变量层
- [Eve 兼容窗口](/zh/docs/reference/eve-compatibility)：支持的 eve 版本
