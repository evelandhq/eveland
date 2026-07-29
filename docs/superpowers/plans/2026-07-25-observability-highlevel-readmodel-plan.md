# Built-in 观测收窄为 high-level 读模型

日期：2026-07-25
分支：`codex/private-agent-observability`
状态：待 review（未实现）

## 目标

Built-in 的职责只是把 Eveland **原有的**运行数据——CPU / memory / disk 容量、token usage 与
成本、Session 事件、组件心跳——改用标准 OTLP 协议收集，投影为 Sessions、Usage 与
Instance Health 必需的读模型。它不存储原始明细，不提供统计视图，也不引入任何原本不存在的
监控项。Observability 页面的职责收敛为「配置外部监控目标与 Agent 采集策略」。一切观测、
统计与下钻由外部 OTLP 后端（Elastic / Custom OTLP / Langfuse）承担。

> **修订历史（同日三轮）**
>
> 1. 初版：删 raw 明细表，改为 rollup 聚合，保留 Platform operations / Deployment lifecycle
>    两个统计板块
> 2. 二轮：页面不应展示统计信息 → 删两个板块与 `platform_operation_rollups`、
>    `runtime_lifecycle_events`；traces 随之没有 Built-in 读模型，Collector 不再向 Built-in
>    发送 traces
> 3. 三轮（最终）：Built-in 的范围明确为「原有监控改用 OTel 协议收集，不新增监控」→
>    `collector_delivery_state` 与 Collector delivery 板块也属于新增监控，一并删除；
>    Collector 自身指标只发第三方；`/system/observability/activity` endpoint 取消
>
> 下文以最终形态为准。

## 现状事实

本地库运行约 8 小时后的实测体量：

| 表 | 行数 | 大小 | 性质 |
| --- | --- | --- | --- |
| `otlp_metric_points` | 179,727 | 278 MB | raw |
| `otlp_spans` | 14,402 | 27 MB | raw |
| `otlp_batches` | 2,626 | 20 MB | raw payload + 幂等去重 |
| `otlp_log_records` | 28 | 240 kB | raw |
| `host_metric_samples` | 75 | 128 kB | 派生读模型 |
| `sessions` / `session_nodes` / `session_events` / `model_usage_events` | 4 / 0 / 0 / 0 | 168 kB | 派生读模型 |

约 800 MB/天，30 天保留期约 24 GB。raw 占 325 MB，派生读模型合计不到 1 MB。

写入来源分布（`otlp_metric_points`）：

| service_name | points | 占比 |
| --- | --- | --- |
| `eveland-otel-collector` | 142,539 | 79% |
| `eveland-worker` | 26,529 | 15% |
| `eveland-api` | 5,337 | 3% |
| `eveland-gateway` | 5,310 | 3% |
| `eveland-agent` | 12 | 0.007% |

Collector 自身导出 46 种 internal metrics（`telemetry.metrics.level: detailed`），
其中页面只消费 4 种。

`apps/api/src/app-otel-routes.ts:81-111` 的 ingest 路径已经天然分成两组独立调用，
派生投影全部从 payload 直接计算，不依赖 raw 表：

- raw：`ingestOtlpBatch`、`ingestOtlpSpans`、`ingestOtlpLogRecords`、`ingestOtlpMetricPoints`
- 派生：`ingestAgentEvent`（← `projectAgentEventsFromOtlpLogs`）、`upsertWorkerHeartbeat`、
  `recordHostMetric`（← `projectInstanceTelemetryFromOtlpMetrics`）

## 已定决策

1. **放弃 p95**。high-level 只保留 count、errors、error_rate、avg。
   现实现 `postgres-otel-store.ts:216` 的 `percentile_cont(0.95)` 需要全量 raw span，
   与本方案不兼容；不引入 histogram 近似。
2. **细粒度只在启用 Elastic 或 Custom OTLP destination 时才有**。Langfuse 的能力声明是
   `signals: ["traces"]`、`domains: ["agent"]`，只承接 Agent traces；platform / runtime /
   capacity 域的细粒度没有外部承接时就不存在，Eveland 不做本地兜底。
3. **保留 hash-only 收据**。去掉 payload 列，只留 `(signal, payload_hash, received_at)`。
   最终形态下已无累加型写入，去重不再用于防重复计数，但收据是 Built-in 接收状态与
   Collector 在线判断的唯一证据。

## 保留 / 删除 / 新增

### 保留（不改）

- `sessions`、`session_nodes`、`session_events`、`model_usage_events` —— Usage 与 Sessions 列表
- `host_metric_samples`、worker heartbeat —— Instance Health 宿主机与 worker 在线
- `jobs`、`runtime_instances`（`getInstanceWorkload`）—— Instance Health workload
- `observability_policies`、`observability_destination_health`

### 删除

- `otlp_spans`
- `otlp_log_records`
- `otlp_metric_points`
- `otlp_batches` 的 `payload` 列

### 新增

无。Built-in 不新增任何表。`otlp_batches` 退化为 `(signal, payload_hash, received_at)`
去重收据，同时充当 Built-in 接收状态与 Collector 在线证据。

最终观测相关表只有三张，全部是配置或收据，没有一张是观测数据：
`observability_policies`、`observability_destination_health`、`otlp_batches`。

页面最终三个板块：Built-in（接收状态）、External destinations（配置）、
Agent capture（采集策略）。

## Collector 只向 Built-in 发送 logs 与 metrics，自身指标只发第三方

traces 没有任何 Built-in 读模型，转发只会换来每批一次全量解析。`BUILT_IN_SIGNALS`
（`process-collector-observability.ts`）因此只含 logs 与 metrics，builtin 的 traces pipeline
与 `filter/builtin_eveland` 的 `trace_conditions` 一并移除，`infra/otel/collector.yaml` 同步。
api 的 `/internal/otel/v1/traces` 入口保留 traces 接收能力（spec 的入口契约不变），只是不再
有人往那儿发。

Collector 自身的 internal metrics 同理：builtin 的 `metrics/collector_self` pipeline 与
`filter/collector_self` 全部移除。`prometheus/collector_self` receiver 与
`resource/collector_self` processor 保留，因为渲染逻辑在外部 destination 接收 metrics 且
包含 platform domain 时会为它生成 `metrics/collector_self_<kind>_<id>` pipeline —— Collector
的投递量与队列压力交给第三方产品，Eveland 不建本地视图。

## ingest 改动

`apps/api/src/app-otel-routes.ts`：

- 三个投影函数全部保留并全量执行。`acceptedItems` 与 `partial_success` 拒绝计数由「有多少
  item 通过投影」得出，这是 OTLP 协议义务，与是否存储无关 —— 这也是唯一「必须解析、结果
  本身不落库」的部分
- traces：只跑投影取拒绝计数，不写任何表
- logs：`projectAgentEventsFromOtlpLogs` → `ingestAgentEvent`（Session 事件、token usage）
- metrics：`projectInstanceTelemetryFromOtlpMetrics` → `upsertWorkerHeartbeat` /
  `recordHostMetric`（组件心跳、CPU / memory / disk）

去重收据仍每批写入，它是 Built-in 接收状态与 Collector 在线判断的唯一来源。

## 查询 / 路由改动

| 位置 | 改为 |
| --- | --- |
| `GET /system/observability/activity` | **删除**。页面不再有任何观测数据可读 |
| `publicPolicy` | `latestOtlpBatchReceivedAt()` 提供 Built-in 接收状态 |
| `instance-health.ts` | Collector 在线状态改用 `latestOtlpBatchReceivedAt()`（它是 Built-in 唯一发送方，最近有批次即在线；90 秒 stale 阈值不变） |
| `app-query-routes.ts` | 删除 `GET /sessions/:id/telemetry` |
| `store-domains.ts` / `postgres-otel-store.ts` | 只留 `ingestOtlpBatch`、`latestOtlpBatchReceivedAt`、`pruneOtlpTelemetry({receiptsBefore})`、`pruneDerivedAgentTelemetry` |

`core/observability.ts` 删除 `CollectorDelivery*` 全部类型与
`summarizeCollectorDelivery` / `projectCollectorDeliveryStates` /
`collectorDeliveryMetricKind` / `collectorExporterIdFromAttributes`。
`COLLECTOR_SELF_SERVICE_NAME` 与 `collectorExporterComponentId` 保留 —— worker 渲染外部
destination 的 exporter 命名与 resource processor 仍需要它们。

### Sessions 详情的 Agent 明细

`GET /sessions/:sessionId/telemetry` 与 `session-trace-view.tsx`、`session-telemetry.ts`
全部删除。`/sessions/:id/nodes` 与 `/sessions/:id/usage` 保留，详情页仍有节点树与
token / 成本。span 级下钻由接收 Agent traces 的外部 Destination 提供。

## 收窄写入源

- builtin 的 traces pipeline、`metrics/collector_self` pipeline、
  `filter/builtin_eveland` 的 `trace_conditions`、`filter/collector_self` 全部移除
- `telemetry.metrics.level` 由 `detailed` 降为 `normal`
- `infra/otel/collector.yaml` 与 worker 渲染保持一致（有测试断言两者相等）

Collector 配置语法用真实二进制验证过：`metric_conditions` 是 filterprocessor 的合法字段
（对照实验：乱写字段名报 `invalid keys` 并 exit=1），OTTL 里必须写 `metric.name`，裸 `name`
会被拒绝。最终 seed 配置 `validate` exit=0。

## spec.md 改动

- **Observability 段开头**：页面职责是配置外部监控目标与采集策略，不承担观测展示
- **Built-in 定义**：职责是把原有运行数据（CPU / memory / disk、token usage 与成本、
  Session 事件、组件心跳）改用 OTLP 协议收集；不存储原始明细、不提供统计视图、
  不引入任何原本不存在的监控项
- **新增一段**：Collector 只向 Built-in 发送 logs 与 metrics，traces 只发外部
- **入口契约段**：`partial_success` 拒绝计数由投影结果得出，与是否存储无关
- **外部 Destination 列表**：Collector 自身 internal metrics 只发外部，不进 Built-in；
  未启用 Elastic / Custom OTLP 时 platform/runtime 的 trace 与 log 不在任何地方留存
- **retention 段**：只剩 capacity 30 天、Session/Usage 90 天、收据覆盖重试窗口
- **Instance Health 段**：Collector 状态来自最近一次 OTLP 批次到达时间
- **Sessions 详情段**：删除 span tree 与 LogRecord 明细的表述

Built-in「始终启用、不提供配置或关闭入口」不变。

## 迁移

本分支原有的 `0027`–`0033` 全部作废，压成单个 `0027_private_agent_observability`
（3 张表：`observability_policies`、`observability_destination_health`、`otlp_batches`，
外加 `session_events` 的列重命名）。观测 schema 尚未发布，历史里不应留下「建了又删」的痕迹。

不能逐个手改历史迁移文件：drizzle 的 `meta/NNNN_snapshot.json` 是链式累积快照，改动中间
某个迁移会让其后所有快照失配，后续 `db:generate` 会基于错误基线出 diff。可靠的重做方式是
截断 journal 到分支起点（`0026`）、删除其后的 sql 与 snapshot，再 generate 一次。

generate 需要回答一个交互式 prompt：`session_events.telemetry_event_id` 是新建列还是从
`observer_event_id` 重命名。原 `0029` 用的是 `RENAME COLUMN`，必须选 rename，否则会生成
add + drop 并在其他环境重放时丢列数据。非 TTY 环境下 drizzle-kit 直接报错，管道喂输入也不被
交互库接受，需要用 pty 驱动（`pty.fork` + 检测 prompt 后写 `\x1b[B\r`）。生成后必须确认
SQL 里是 `RENAME COLUMN`；若选错，两种方式的最终 schema 相同，只需手工修 SQL 文本、
snapshot 无需改动。

本地两个库 drop 重建后 migrate。`observability_policies` 一行（含加密的 Langfuse 凭证）
在重建前导出、重建后 UPSERT 回去 —— `APP_SECRET_KEY` 未变，加密内容直接可用。

## 实施结果

| | 改前 | 改后 |
| --- | --- | --- |
| `eveland` 库总体量 | ~400 MB（8 小时流量） | 迁移后为空库，稳态只有收据与读模型 |
| 观测相关表 | `otlp_spans` / `otlp_log_records` / `otlp_metric_points` / `otlp_batches(payload)` | `otlp_batches`（收据）—— 其余两张是配置表 |
| Observability 页板块 | 6 个 | 3 个（Built-in / External destinations / Agent capture） |
| Collector → Built-in | traces + logs + metrics + self-metrics | logs + metrics |
| Built-in 读模型 | Sessions / Usage / Instance Health / 平台聚合 / 投递状态 | Sessions / Usage / Instance Health |

## 与计划的偏差

**没有对 `system.cpu.time` 加 Collector filter。** `system.cpu.utilization` **是**
Instance Health 的 CPU 数据源（`session-collector/src/otlp.ts` 用它算 `cpuPercent`），
不能降维，`hostMetrics: true` 也不能关。真正无消费者的只有 `system.cpu.time`（全仓库零
引用），它在 ingest 侧就被丢弃、不再入库。剩下的只是每分钟约 96 个点的传输浪费；为它维护
一份「HostMetricsInstrumentation 无消费者指标黑名单」会随上游版本漂移，收益不对等。

**前两轮的 p95 与 rollup 幂等决策随板块删除失效**：不再有聚合表，也不再有累加型写入，
因此 ingest 里不需要用 `duplicate` 跳过累加。收据仍然保留，因为它是接收状态与 Collector
在线的唯一证据。

**能力损失（已确认接受）**：Collector 的实际投递成功率与失败数在 Eveland 侧不可见。只配
Langfuse（只收 traces）时，只剩 `observability_destination_health` 的五分钟可达性探测。
要看真实投递情况需要启用接收 metrics + platform domain 的 Elastic 或 Custom OTLP。

## 验证记录

- `pnpm -r typecheck`：通过
- `pnpm -r test`：全包通过（core 16 文件、db 19、web 23、worker 32、api 18、gateway 4、
  agent-auth 5、session-collector 2、agent-observer 6、agent-scheduler 1、
  platform-observability 1、sandbox-bwrap 7、docs 1）
- 含 `EVELAND_POSTGRES_TEST_URL` 的 integration：api 111、worker 301、gateway 27、
  agent-auth 26 全通过；db 109 passed，唯一失败是 pre-existing 的
  `postgres-deletion.integration.test.ts`（要求 jobs 表为空，被同库前序 integration 文件的
  残留 job 干扰；干净库单独跑 2 passed，相关实现本分支零改动）
- `pnpm -r build`：web 与 docs 均 Compiled successfully
- `infra/otel/collector.yaml` 用 `otel/opentelemetry-collector-contrib:0.149.0 validate`
  校验：exit=0
- 迁移后本地库观测相关表确认为 `observability_policies`、
  `observability_destination_health`、`otlp_batches` 三张
