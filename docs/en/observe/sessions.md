---
title: Sessions and usage
description: Trace root and child Eve sessions with deployment provenance and provider-reported usage.
---

Session collection is independent of Playground. Injected Eve hooks use Eveland-private OpenTelemetry providers and send standard OTLP to the managed Collector; Built-in then projects Agent LogRecords into Postgres. Direct Agent requests, Playground, schedules, and child sessions can all appear in the same history. User instrumentation and exporters remain unchanged.

## Session model

A platform Session is the root conversation. Each root or subagent Eve session becomes a SessionNode. Durable Eve identity is scoped to the Project, while individual observations retain the Deployment that produced them.

Child-before-parent delivery and discovery races are expected. Projection merges relationships and provenance idempotently without following arbitrary remote subagent URLs.

## Usage

Usage comes only from Eve's provider-reported `step.completed.data.usage`:

- input and output tokens
- cache-read and cache-write tokens
- provider or AI gateway cost when reported

Missing usage remains explicitly missing; Eveland does not estimate it. At-least-once OTLP delivery cannot double-count already projected usage.

## Telemetry health

Telemetry failure must not make an Agent turn fail. The Collector gives Built-in and every external exporter an independent persistent retry queue. Collector/Built-in liveness is part of **Settings → Instance health**; external destination probe state is shown under **Settings → Observability**.

## Deeper reference

- [Observability behavior contract](/docs/reference/observability): OTLP batch storage, SessionNode tree projection rules, and retention policy
- [Observability design decisions](/docs/reference/design/observability): why OpenTelemetry was chosen as the sole telemetry transport
- [Health and diagnostics](/docs/operations/diagnostics): verifying Collector health and troubleshooting missing usage
