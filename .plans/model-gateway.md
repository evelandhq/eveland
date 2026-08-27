# Model Gateway：统一模型 API（BYOK 数据平面）

- 状态：计划（讨论定稿 2026-08-27，未动代码）
- 分支：`claude/model-gateway-unified-api-53a545`
- 参与讨论：Michael + Claude（本文档）+ Codex（架构核对轮）

## 一句话定义

> Eveland 自己拥有的 Model Gateway 数据平面：底层严格 BYOK，只兼容 Vercel/AI SDK
> 的调用体验，不依赖 Vercel 的推理服务。

Agent 作者只写：

```ts
import { defineAgent } from "eve";

export default defineAgent({
  model: "zai/glm-5.3-flash",
});
```

换模型 = 改一个字符串。不 import provider 包、不配 provider key、agent 代码零改动。

## 动机

- 现状：每个 agent 自己 import `@ai-sdk/deepseek` 等 provider 包 + 每个项目单独配
  provider key，换模型（如试用 GLM 5.3 flash）要改代码、改依赖、改 secrets。
- eve 0.44/0.45 已把字符串模型定义为 gateway 模型（`docs/en/reference/eve-compatibility.md`），
  语法今天就是合法的——缺的只是把解析落点从 Vercel 换成我们自己。
- 我们不接受 Vercel AI Gateway 作为推理依赖（违背产品初心），但接受它的**调用体验和
  wire 协议**作为兼容目标。

## 已验证的关键事实（eve 0.45.2 / ai@7.0.73，代码核对过）

1. `defineAgent` 的 `model` 类型是 `string | LanguageModel`；eve 对字符串**不做任何处理**，
   原样交给 AI SDK（`$EVE/dist/src/runtime/agent/resolve-model.js` 返回 `e.id`）。
2. AI SDK 的字符串解析：`globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway`
   （`ai/dist/index.js` `getGlobalProvider()`）。`AI_SDK_DEFAULT_PROVIDER` 是**文档化的
   扩展点**（`index.d.ts` 有 declare），不是 monkeypatch。今天 eve 里没有任何代码设置它。
3. 默认 gateway 客户端是 `@ai-sdk/gateway`（本仓库锁 4.0.59），wire 是 Vercel 内部协议
   （`POST /v4/ai/language-model`、`GET /v4/ai/config`），默认
   `https://ai-gateway.vercel.sh/v4/ai`，支持 `createGateway({ baseURL })` 重定向。
   认证读 `AI_GATEWAY_API_KEY` env。`AI_GATEWAY_BASE_URL` 这样的 env **不存在**。
4. eve 另有**硬编码** catalog 依赖：`https://ai-gateway.vercel.sh/v1/models/catalog`
   （`$EVE/dist/src/internal/gateway.js`，不可配置），用于 context window / max output /
   provider mapping 元数据；动态模型选择拉不到会抛错。
5. eveland 平台代码目前**零** `@ai-sdk/*` 依赖、零模型目录、零 provider registry；
   Playground 无模型选择。model id 只作为 observer 遥测出现（`modelUsageEvents`）。
6. 注入机制成熟可复用：reserved runtime env 层
   （`apps/worker/src/jobs/process-support.ts` `composeDeploymentEnv()` +
   `apps/worker/src/runtime/reserved-environment.ts`），0600 env-file 交付 + 日志掩码；
   build 时注入有 platform-owns-sandbox-choice 先例。

## 核心决策（含被否掉的备选）

| #   | 决策                                                                                  | 理由 / 被否方案                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **做代理（数据平面），不做直连注入**                                                  | 产品目标是凭证间接层：agent 拿 deployment 级 `AI_GATEWAY_API_KEY`，真 key 只存在于 gateway。直连注入（真 key 进 agent env）和进程内换钥匙（boot 时换 key 进内存）都藏不住——同进程 wrap `globalThis.fetch` 即可读到 Authorization。供应商不支持临时/scoped 凭证，所以"凭证隐藏 + 直连"无解。                                                                                                                                                                                                                                              |
| D2  | **wire 采用原厂 AI SDK Gateway 协议，不自定义**                                       | 终局是 eve 上游支持可配置 gateway origin——届时 eve/AI SDK 构造的是原厂 `@ai-sdk/gateway` 客户端，我们必须说原厂协议。自定义 wire 会堵死终局。协议漂移可控：预加载包钉客户端版本，server 只需匹配所钉版本，配双端 contract test。（曾被否：自定义 wire、纯 `/v1/chat/completions` OpenAI-compatible——后者丢 anthropic 特性且和字符串解析路径对不上。）                                                                                                                                                                                    |
| D3  | **独立 `apps/model-gateway`，不进现有 agent gateway**                                 | 流量形态（长流 SSE）、持有的密钥（明文 provider key）、攻击面完全不同。                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D4  | **接入路径：预加载注入先行，上游 configurable origin 为加速项**                       | build 时注入 `@evelandhq/model-gateway-runtime` 预加载包（`NODE_OPTIONS --import`），设置 `AI_SDK_DEFAULT_PROVIDER = createGateway({ baseURL: EVELAND_MODEL_GATEWAY_URL })`。上游 issue 早发（Phase 1 并行），但**不作为依赖**——参考 sandbox backend hook 从未等到的教训。                                                                                                                                                                                                                                                               |
| D5  | **BYOK fail-closed，与 Vercel 有意不同**                                              | 只用管理员配置的凭据；无可用 key 直接失败；fallback 只在用户自己配置的多个 provider/key 之间发生；绝不回退到 Eveland/Vercel 的付费账户。写进产品文档作为差异点。                                                                                                                                                                                                                                                                                                                                                                         |
| D6  | **口径收窄：配了哪家 key，那家模型才点亮**                                            | 不声称"支持目录里所有模型"。`zai/glm-5.3-flash` 的 `zai` 是创作者命名空间，实际可由 Z.ai/Baseten/Novita 等承载；开源模型常无第一方 API。                                                                                                                                                                                                                                                                                                                                                                                                 |
| D7  | **Provider key 绝不进 Shared Agent Environment / project secrets 注入路径**           | Shared Agent Environment 会注入所有 agent 进程（`docs/en/reference/agent-environment.md`）；Model Gateway 的核心价值就是 agent 永远看不到真 key。独立加密存储：AES-256-GCM，但用**专用 `EVELAND_MODEL_GATEWAY_SECRET_KEY`**（API 侧加密写入、model-gateway 按请求解密，二者共享此 key），**不复用 `APP_SECRET_KEY`**——否则 model-gateway 拿到它即可解密全部 project secrets，破坏独立安全边界。非对称 envelope 加密（API 连持久化值都解不了）首版不做。                                                                                  |
| D8  | **`AI_GATEWAY_API_KEY` 绑定 RuntimeInstance，不是模糊的 "deployment/project-scoped"** | 走 reserved 层注入（`EVELAND_SCHEDULER_RUNTIME_SECRET` 先例）。claims/记录：projectId + deploymentId + runtimeInstanceId；服务端只存 hash；每次 start/restart/cold activation 轮换；process stop/failure/archive 即吊销——env 文件属于一次进程启动，停止的进程不留长期可用凭据。吊销语义：**后续新请求立即 401**；在途 SSE 不主动掐断（v1 决策：token 仅在请求建立时校验，在途流由最大流时长上限兜底；实例停止时流本随进程消亡）。副产品：per-project 用量归属/限额天然可得；真 key 轮换对 deployment 零打扰（绕开 .env 冷启动 gotcha）。 |
| D9  | **首版只做 language model**                                                           | 覆盖 streaming、tools、reasoning、usage、vision。embedding/image/video/speech/realtime/reranking 全部后置。                                                                                                                                                                                                                                                                                                                                                                                                                              |

## 架构

```
Eve Agent
  model: "zai/glm-5.3-flash"
        │  预加载包设置 AI_SDK_DEFAULT_PROVIDER
        │  = createGateway({ baseURL: $EVELAND_MODEL_GATEWAY_URL })
        │  携带 AI_GATEWAY_API_KEY（deployment 级，reserved 层注入）
        ▼
apps/model-gateway（数据平面）
  ├─ 认证（deployment token 校验/吊销）
  ├─ 模型目录 + canonical model → provider route mapping
  ├─ AI SDK Gateway wire 协议（/v4/ai/language-model 等，SSE 流式）
  ├─ 超时、重试、（后置：配额/预算、BYOK 内 fallback）
  └─ usage / latency / provider-attempt 遥测（禁止记录请求体）
        │  严格协议边界（见"安全契约"）：schema 校验 + 清洗后由 provider 包重放 → 流回
        ├─ Z.ai ────── 管理员的 ZAI key
        ├─ DeepSeek ── 管理员的 DeepSeek key
        ├─ Anthropic ─ 管理员的 Anthropic key
        └─ 其他已配置 provider（OpenAI-compatible 覆盖大多数）

控制面
  Dashboard（Model Gateway 一级入口）→ API → 加密保存 Provider Connection
                                              └→ model-gateway 按请求解密使用
```

### 模型路由表

```
canonical model:  zai/glm-5.3-flash
routes:
  zai      → glm-5.3-flash
  baseten  → zai-org/GLM-5.3-Flash
  novita   → zai-org/glm-5.3-flash
```

仅当"eveland 已实现该 provider adapter **且** 管理员配了对应 key"时标记可用。
Dashboard 目录四态：**可用 / 缺少 Provider Key / Provider 尚未支持 / 模型已下线**。

路由真相是 **eveland 自有的版本化 route registry**（checked-in 或持久化）：
Vercel 的 `/v1/models` 只有展示信息，`canonical → providerModelId` 映射来自
`/v1/models/catalog`——那是 Vercel/eve 的非稳定耦合面，只能作**同步输入**，
不是每次请求的在线真相。同步失败用 last-known-good；下线模型置 tombstone
（不自动删除旧 Release 仍依赖的 route）；registry 变更可审计、可回滚。

### 控制面 UI：一级板块 "Model Gateway"（自有子导航）

**不放进 Settings。** Model Gateway 是独立的一级板块（`globalNavigationItems`，与
Projects/Deployments/Usage 并列），进入后有自己的子侧边栏——参考 Vercel AI Gateway
的导航（Overview / Logs / Budgets / API Keys / BYOK / Model List…），复用现有
sidebar-shell 模式（project-sidebar / settings-sidebar 同款骨架）。

v1 子导航：

| 页面          | 谁用  | 内容                                                                                                                                                                                                                                                                                                       |
| ------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**  | 全员  | 启用状态、请求量/错误率/延迟趋势、top models、provider 健康一览                                                                                                                                                                                                                                            |
| **Models**    | 全员  | 目录四态徽章（可用/缺 Key/未支持/已下线）；主 CTA **复制模型字符串**；筛选（只看可用/按 provider/按能力）；行展开显示 route 表；admin 从"缺少 Provider Key"一键跳 Providers                                                                                                                                |
| **API Keys**  | 全员  | 用户**自助铸造个人 key**（命名、可吊销、write-only 只显示一次），查看各自 key 的消耗；admin 可见全部；自动铸造的 RuntimeInstance token 只读列出（吊销入口同时挂 deployment 详情页）                                                                                                                        |
| **Usage**     | 全员  | per-project / per-model / per-key 消耗（业务统计来源仍是 observer 链路，见遥测边界；gateway 补充 attempt/latency 维度）                                                                                                                                                                                    |
| **Providers** | admin | BYOK 连接卡片列表（provider 名、key 后 4 位掩码、状态徽章 Active/Key invalid、解锁模型数、添加人/时间）。添加：选 provider → 粘贴 key →（OpenAI-compatible 可选 baseURL 覆盖）→ **保存时在线验证**，失败不静默保存（fail-closed）。write-only、永不回显、轮换即重贴。文案明确"key 永远不会进入 agent 进程" |
| **Settings**  | admin | 启用开关（staged rollout）、同名 `AI_GATEWAY_API_KEY` 冲突诊断、（后置）对外暴露开关                                                                                                                                                                                                                       |

后置：Logs（attempt 级明细）、Budgets（精确预算）、Leaderboards 不做。

**个人 API key 引入的新决策**：个人 key 意味着 deployment 之外的调用方（本地
`eve dev`、脚本）——这与安全契约的"私有监听"有张力。解法：私有监听仍是默认；
Settings 提供显式"对外暴露"开关（挂认证的 Traefik 路由，默认关）。未暴露时个人
key 仅限实例内网使用；对外暴露 + 上游 configurable origin 落地后，个人 key 即是
本地 `eve dev` 接入 eveland Model Gateway 的凭据（衔接 backlog 的 eve dev 项）。
token 因此有两类：RuntimeInstance token（自动，D8）+ 个人 API key（手动、命名、
绑定成员、独立吊销、独立计量），同存 hash、同进掩码集合。

Adapter 策略：config-driven 为主——deepseek/zai/moonshot/alibaba 等走
`@ai-sdk/openai-compatible` + `{baseURL, keyRef}` 配置；anthropic/google 用原生包。
把依赖面压到最小（真实耦合面见"工程注意点·版本耦合"）。

## 安全契约（数据面协议边界，进测试矩阵）

"relay" 不等于原样转发——agent 是不可信输入方，可提交伪造 headers、request 级
byok、路由指令、超大 payload。硬规则（每条配测试，不只是工程注意点）：

- 严格校验 AI SDK V4 请求 schema 与 specification header；未实现的 gateway
  options（`order` / `only` / `models` / `serviceTier` 等）返回 **400**，不静默忽略。
- **丢弃** agent 提交的一切上游 HTTP headers；**明确拒绝** request-scoped
  `providerOptions.gateway.byok`。
- provider、base URL、credential 只能来自服务端 registry——请求内容无法影响路由
  目标和凭据选择。
- 请求体 / 文件（base64）/ 工具数量 / 输出设上限；client abort 必须传播到上游
  provider 请求（不留孤儿流）。
- **私有监听**：不挂公共 Traefik route；systemd agent 走 `127.0.0.1`，Docker agent
  走 `host.docker.internal`。
- build 环境只拿到 preload + `EVELAND_MODEL_GATEWAY_URL`，**绝不拿到
  `AI_GATEWAY_API_KEY`**（`selectBuildVariables` 剥离 reserved 键已保证，仍需显式测试）。
- `NODE_OPTIONS`、`EVELAND_MODEL_GATEWAY_URL`、`AI_GATEWAY_API_KEY` 进平台保留
  env 名单（`RESERVED_RUNTIME_ENVIRONMENT_KEYS`）；token 进完整日志掩码集合
  （maskKnownSecrets）。
- v1 就带 **per-project 并发与速率上限**（精确预算后置）——单个 agent 不得耗尽
  全平台共享的 provider quota。

## 上线策略（staged rollout）

用户今天可能已在 Shared Environment / Project Secrets 配了 Vercel 的
`AI_GATEWAY_API_KEY`；平台把它变成 reserved 键会**无声改变现有推理路径**。因此：

- Model Gateway 初始关闭，实例级显式启用。
- 启用前检测同名用户配置并给出迁移警告；reserved 层覆盖有可见诊断
  （build log `WARNING:` 已有先例，runtime 侧补齐）。
- 现有 deployment 不自动切换，重新部署后生效（与 env 冷启动语义一致）。
- provider object（如 `deepSeek(...)`）继续直连，不受影响。定位：Model Gateway 是
  **字符串模型的默认落点**，不是强制的模型出口防火墙。
- 宣称口径：首版可宣称"不依赖 Vercel 推理服务"，**不可**宣称"完全不访问 Vercel"
  （build 期 catalog 拉取仍在，见待验证项·已确认）。

## 落地顺序

1. **协议验证 spike**（窄）：Z.ai + DeepSeek、language model、streaming + tools + usage。
   **核心测试跑本地 mock provider 走完整 CI**（不依赖外部余额和服务状态）；真实
   Z.ai/DeepSeek key 只作可选 live smoke。验收：fixture agent 写
   `model: "zai/glm-5.3-flash"`，经 model-gateway 用管理员配置的 zai key 打通，
   Lima 端到端流式回包；中途吊销 runtime token → **后续新请求立即 401**（在途 SSE
   语义按 D8）。同时**并行发上游 issue**：eve/AI SDK 可配置 gateway origin
   （推理入口 + catalog 一起切）。
2. **平台化**：独立 `apps/model-gateway` 服务、Provider Connections 设置页（控制面）、
   deployment-scoped token 铸造/吊销、reserved 层注入 `EVELAND_MODEL_GATEWAY_URL` +
   `AI_GATEWAY_API_KEY`、预加载包 build 时注入。
3. **网络验证（拆两档）**：
   - 3a（首版验收）：封锁 `ai-gateway.vercel.sh/v4/ai/*`（推理路径），build 与真实
     agent turn 全绿——证明推理流量 100% 走 eveland。
   - 3b（gated on upstream）：封锁全域名。当前被 eve 硬编码 catalog URL 卡住，上游
     configurable origin 落地后才可达成。
4. **扩展**：provider routing/fallback（限 BYOK 内部）、预算/配额、更多 provider、
   （可选）OpenAI-compatible 出口 API、非 language 模型类型。

## 待验证项（Lima / spike 期间确认）

- [x] **已确认（读 0.45.2 编译产物）**：静态字符串模型在 **build 期**也会查 catalog。
      `compiler/normalize-agent-config.js` 对字符串走 `withCompiledRuntimeModelLimits`，
      仅当显式提供 `modelContextWindowTokens` 时跳过；否则 `getModelLimits()` 经
      `.eve/cache/model-catalog.json` 磁盘缓存 → 硬编码 Vercel catalog URL 拉取
      （fetch 失败回退 last-known-good 缓存；无缓存且非内置模型则 build 失败；内置
      limits 表仅 3 个模型）。⇒ 3b 确需上游改动；对外宣称口径见"上线策略"。
- [ ] gateway key 存在性诊断：eve 的 info 路由/CLI 探测 `AI_GATEWAY_API_KEY` presence
      ——注入的铸造 token 应能同时满足它；确认 runtime 无噪音告警。
- [ ] `/v4/ai` wire 的完整面：对照钉住的 `@ai-sdk/gateway@4.0.59` 客户端补 contract test
      （language-model、config；`getCredits` 首版不做，见 backlog）。
- [ ] 预加载在 nitro 启动序中的时机：global 必须在首次模型解析前设置。

## 工程注意点

- **长流硬化**：backpressure、心跳、idle-timeout 首版就做进去（playground stream-leak
  与 gateway unbounded-tee 的教训直接适用）。两段心跳分开：eve 客户端 15s read-idle
  由 **agent gateway** 的 heartbeat 处理（0.44.3 轮的
  `EVELAND_GATEWAY_STREAM_HEARTBEAT_MS`）；**model gateway** 的心跳针对的是
  agent → model-gateway 这一段的 SSE / 反向代理 idle timeout。
- **遥测边界**：model-gateway 是全平台 prompt + 明文 key 的汇聚点。显式禁止记录请求体；
  key 仅按请求解密、不落日志（复用 maskKnownSecrets 思路）。**业务用量统计以 eve 的
  `step.completed.data.usage`（现有 observer 链路）为唯一来源**；model-gateway 只产生
  运行状态 / provider-attempt / latency 遥测，避免双计。
- **版本耦合（比"只耦合 `ai` major"更宽）**：实际耦合三样——`ai` major、gateway wire
  版本、eve catalog schema。预加载包必须**捆绑钉死版本的 `@ai-sdk/gateway`**，不能
  依赖 agent 项目恰好解析到相同版本。eve 升级 slide checklist 新增：diff gateway
  客户端协议 + catalog schema + 双端 contract test 过绿。
- **本地 `eve dev` 差距**：不经平台时字符串仍打 Vercel gateway。首版文档说清楚；
  backlog：eveland CLI dev 模式做同样预加载 + credits endpoint 兼容 stub
  （eve CLI setup 用 `getCredits()` 验 key）。

## Backlog（明确后置）

- embedding / image / video / speech / realtime / reranking 模型类型
- `eve dev` 本地接入 + `/v4/ai` credits stub
- OpenAI-compatible 出口 API（供非 eve 客户端使用 model gateway）
- 项目级 key 覆盖（平台级默认之上）、per-project 预算
- 聚合商 provider（openrouter/fireworks）以覆盖无第一方 API 的开源模型
