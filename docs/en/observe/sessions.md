---
title: Sessions and token usage
description: End-to-end conversation tracing, subagent hierarchy visualization, and provider-reported token usage tracking.
---

In Eveland, session tracing and usage metrics are fully integrated into the dashboard, completely decoupled from the interactive Playground. Conversations initiated via public APIs, scheduled cron tasks, or console debugging are unified into a cohesive history tied to their source deployment.

---

## 1. Conversation hierarchy (Session & SessionNode)

Eveland models agent interactions as a structured conversation tree:

- **Root Session**: Represents the end-to-end context initiated by the caller with the primary agent.
- **SessionNode**: When the primary agent spawns subagents or triggers background workflow steps, each step branches as an attached child node.
- **Deployment Provenance**: Every turn and tool call is permanently labeled with the exact deployment version that generated it, enabling clear comparisons across releases.

---

## 2. Accurate model usage tracking

Eveland captures token usage directly from model provider responses during `step.completed`:

- **Input and Output Tokens**: Exact prompts and completion token counts.
- **Cache Hit Tracking**: Tracks Cache Read and Cache Write tokens, allowing precise cost evaluation of context caching.
- **Cost Aggregation**: When upstream AI gateways report financial charges, Eveland aggregates total expenditure per project and deployment.
- **No Synthetic Estimates**: If a provider omits usage metadata for a turn, Eveland records it as missing rather than fabricating guesses.

---

## 3. Telemetry resilience and fault isolation

- **Telemetry failure isolation**: Telemetry network hiccups never cause an agent turn or conversation to fail or stall.
- **Persistent retry queues**: The managed Collector maintains isolated persistent disk buffers for internal Postgres projection and external sinks (e.g. Elastic, Langfuse).
- **Liveness monitoring**: Verify telemetry health and pipeline status under **Settings → Instance health**.

## Deeper reference

- [Observability behavior contract](/docs/reference/observability): OTLP projection model and data retention policies
- [Observability design decisions](/docs/reference/design/observability): rationale behind OpenTelemetry as the sole transport
- [Health and diagnostics](/docs/operations/diagnostics): verifying Collector health and troubleshooting missing usage
