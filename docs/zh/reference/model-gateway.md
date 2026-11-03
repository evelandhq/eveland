---
title: Model Gateway 行为契约
description: 平台如何把 Agent 的字符串模型 ID 接到实例的模型网关，如何为每个项目签发 key，以及用量、成本和部署时校验的规则。
---

**Model Gateway** 是 Agent 调用大模型时经过的网关。管理员为整个实例配置一个，所有项目默认使用。它和 Eveland 的 [Agent Gateway](/zh/docs/reference/routing) 是两回事：后者处理 Agent 的入站流量，前者承载 Agent 的出站模型调用。设计理由见 [Model Gateway 设计决策](/zh/docs/reference/design/model-gateway)。

---

## 1. 支持的网关

| 类型              | 填写什么                            | 每个项目的 key             | 成本                       |
| ----------------- | ----------------------------------- | -------------------------- | -------------------------- |
| LiteLLM           | Base URL（以 `/v1` 结尾）+ 管理 key | Eveland 为每个项目签发一把 | 记录 LiteLLM 报告的成本    |
| OpenRouter        | Base URL + API key                  | 所有项目共用这一把         | 记录 OpenRouter 报告的成本 |
| Vercel AI Gateway | AI Gateway API key                  | 所有项目共用这一把         | AI Gateway 原生成本        |
| OpenAI-compatible | Base URL + API key                  | 所有项目共用这一把         | 不记录（缺失）             |

其他提供 OpenAI 兼容 Chat Completions 端点的网关（Cloudflare AI Gateway、Portkey、Bifrost、Kong、Agent Router、New API 等）按 OpenAI-compatible 接入。LiteLLM 请避开 PyPI 上被投毒的 1.82.7 和 1.82.8。

---

## 2. 生效范围

- **只影响字符串模型 ID。** Agent 写 `model: "anthropic/claude-sonnet-4.5"` 这样的字符串时，调用经过 Model Gateway；Agent 传入的模型对象（例如自己 `createOpenAICompatible(...)` 构造的模型）不受影响。
- **Agent 自己的 Provider 优先。** Agent 在自己的 instrumentation 里设置了 `globalThis.AI_SDK_DEFAULT_PROVIDER`，平台就不覆盖。
- **模型 ID 原样转发。** Eveland 不改写模型 ID，也不维护别名表；别名在网关上配置（例如 LiteLLM 的 `model_name`）。建议统一使用 Vercel 模型目录的 slug，这样 eve 能在构建时查到上下文窗口，Agent 不必手写 `modelContextWindowTokens`。
- **只对 eve 1.0 及以上的 Release 生效。** eve 0.83 的 Release 照常构建，构建日志会写一条 `WARNING`，模型调用保持源码原样。
- **未配置时没有任何效果。** 平台总会把 Provider 模块注入 eve 1.0 的 Release，但在实例没有配置网关、或项目选择不使用时，它什么也不做。所以部署之后再配置网关，只需重启，不需要重新构建。

---

## 3. 实例配置（`/settings/model-gateway`）

- 只有管理员能查看和修改。
- 凭据（LiteLLM 的管理 key，或其他类型的共享 key）用 `APP_SECRET_KEY` 加密存储，保存后不会返回浏览器。只改 Base URL 以外的内容时可以留空，保留原凭据；改了类型或 Base URL，就必须重新填写。
- **测试连接**：LiteLLM 用管理 key 请求 `/key/info`，其他类型请求模型列表。请求不跟随重定向，有超时，不回显响应体。不填凭据时，只会把已保存的凭据发给它原本所属的网关。
- 保存或移除网关后，所有使用平台网关的项目（选项不是"关闭"的项目）的在线部署都会排队重启，重启沿用原 Release。
- **LiteLLM 管理 key 只在平台内部使用**，由 API 和 Worker 用来签发、轮换、吊销项目 key，不会出现在任何 Agent 的运行环境里。

---

## 4. 项目选项（项目设置 → Model Gateway）

| 选项             | 行为                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 平台 key（默认） | LiteLLM：使用 Eveland 为本项目签发的 key。其他类型：使用实例共享 key。                                                  |
| 项目自己的 key   | 使用项目填写的 key（加密存储，只下发给本项目的运行进程）。网关地址仍由实例决定。离开这个选项时，已保存的 key 会被清除。 |
| 关闭             | 本项目的部署不使用平台网关，Agent 按源码原样调用模型。                                                                  |

修改选项会为本项目的在线部署排队重启。

---

## 5. LiteLLM 的项目 key

- **签发时机**：项目以"平台 key"方式第一次启动（部署、重启、冷启动激活或定时任务触发）时签发，之后一直复用。别名为 `eveland-<projectId>`，`metadata` 里记录 `eveland_project_id`。
- **崩溃安全**：key 的值由 Eveland 生成，先加密写入数据库，再注册到 LiteLLM。注册中断后重试时，如果别名已存在，Eveland 会用保存的 key 查询 LiteLLM：能查到就视为已成功；查不到说明别名被其他 key 占用，启动失败并提示管理员处理。
- **失败即失败**：签发失败时部署或启动失败，**绝不**退回使用共享 key。
- **轮换**：项目设置中的"轮换 key"会排队一个任务：先生成并保存新 key，再调用 LiteLLM 的 `/key/{key}/regenerate`（旧 key 保留 1 小时宽限期），然后重启本项目的在线部署。轮换和本项目的导入、构建串行执行。
- **吊销**：删除项目时，Eveland 在删除项目记录之前吊销它的 key；失败会随删除任务重试。
- **切换或移除网关**：管理员改了网关地址、类型或移除网关后，旧网关上的 `eveland-*` key 不会被自动吊销（Eveland 已无法访问旧网关）。项目在下次启动时会在新网关上重新签发。删除项目时如果遇到这种 key，删除日志会写 `WARNING` 并给出别名，请到旧网关上手动删除。
- **预算和限流**：Eveland 不设置 `max_budget`、`models` 等限制，请在 LiteLLM 后台按别名调整。
- LiteLLM 只保存 key 的哈希；Eveland 查询和吊销时只传 sha256 哈希，原始 key 不会出现在 URL 或网关访问日志里。

---

## 6. 运行时契约

平台在每个 eve 1.0 的 Release 中写入：

- `agent/instrumentation/eveland-model-gateway.js`：一个 instrumentation 文件，在 `setup` 中安装 Provider。`setup` 在所有 instrumentation 模块加载完成后、第一个事件之前运行，所以 Agent 在模块顶层设置的全局 Provider 一定先于它生效。如果源码里已有同名（任意扩展名）的文件，构建失败。
- `.eveland/model-gateway/runtime.mjs`：打包好的 Provider 代码，随 Release 一起固定。

运行时通过三个**平台保留变量**下发配置（项目同名变量会被覆盖）：

| 变量                         | 内容                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `EVELAND_MODEL_GATEWAY_KIND` | 网关类型；项目不使用网关时为空                                                         |
| `EVELAND_MODEL_GATEWAY_URL`  | Base URL；Vercel 类型为空                                                              |
| `EVELAND_MODEL_GATEWAY_KEY`  | 本项目使用的 key（签发的、项目自己的或共享的），经 root 所有、权限 0600 的环境文件下发 |

Provider 的行为：

- 发往网关的请求总是带 `stream_options.include_usage`，流式调用也能上报 token 用量。
- 网关报告的美元成本写入 `providerMetadata.gateway.cost`，eve 会把它记入 `usage.recorded` 的 `costUsd`：OpenRouter 和 LiteLLM 取响应体（流式时取最后一个 chunk）的 `usage.cost`；LiteLLM 的非流式响应缺少它时，取响应头 `x-litellm-response-cost`。没有成本来源时，成本保持缺失，不做估算。
- 配置不完整（例如类型不认识、缺少 key）时，进程启动失败，错误信息只包含变量名，不包含变量值。

---

## 7. 部署时的模型校验

构建完成后，Worker 从 eve 的编译产物（`.output/.eve/compile/compiled-agent-manifest.json`）读出根 Agent 和各子 Agent 的静态模型 ID，用**本项目的 key** 请求网关的模型列表：

- 网关返回了列表，但其中没有某个 ID：部署失败，构建日志写 `ERROR` 并给出最接近的可用 ID，Release 被丢弃。
- 列表接口不可用：构建日志写 `WARNING`，部署继续。
- 动态选择的模型无法静态校验，不在校验范围内。

---

## 8. 模型目录缓存

eve 构建时按模型 ID 查询 Vercel AI Gateway 的模型目录来获取上下文窗口。Worker 把目录缓存在 `<EVELAND_DATA_DIR>/cache/model-catalog.json`，每天最多获取一次，获取失败时继续使用旧的那份；每次构建前把它写入 Release 的 `.eve/cache/model-catalog.json`，所以构建期间 eve 不会联网获取。构建日志会记录目录的获取时间。这与是否配置 Model Gateway 无关，对所有 eve 1.0 构建都生效。

---

## 9. 本地开发

`eve dev` 默认通过 `/login` 连接开发者自己的 Vercel 账号，不需要任何配置。要在本地使用同一个非 Vercel 网关（需要 eve ≥ 1.0.0-rc.2）：

```ts title="agent/instrumentation/model-gateway.ts"
import { defineInstrumentation } from "eve/instrumentation";
import { installModelGateway } from "eveland/model-gateway";

export default defineInstrumentation({
  setup() {
    installModelGateway();
  },
});
```

把 `eveland` 加为依赖，再在 `.env.local` 中设置 `EVELAND_MODEL_GATEWAY_KIND`、`EVELAND_MODEL_GATEWAY_URL` 和 `EVELAND_MODEL_GATEWAY_KEY`（使用为开发者单独开的 key，不要使用平台签发给项目的 key）。部署到 Eveland 后，这个文件和平台注入的文件是同一个模块、读同一组变量，先运行的那个安装 Provider，另一个什么也不做。

## 相关参考

- [Model Gateway 设计决策](/zh/docs/reference/design/model-gateway)：为什么这样设计
- [Agent 环境与变量层级](/zh/docs/reference/agent-environment)：保留变量层
- [Eve 兼容性窗口](/zh/docs/reference/eve-compatibility)：支持的 eve 版本
