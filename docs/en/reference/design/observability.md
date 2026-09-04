---
title: Why OpenTelemetry is the transport
description: Push-first, OTel-only observability architecture with private providers and rigorous agent telemetry trust boundaries.
---

## The Decision

Eveland relies on the **OpenTelemetry API, standard semantic conventions, and OTLP** as its sole telemetry transport. The platform does not introduce proprietary telemetry envelopes or bespoke wire protocols, relying on the stock OpenTelemetry Collector for reliable fan-out and retries.

---

## 1. Why push-first, injected at release time

Eveland guarantees that **conversation and turn tracking covers every interaction entrypoint**:

- **Limitations of gateway-only capture**: Inspecting traffic exclusively at the edge proxy misses direct port invocations, background cron schedules, webhook channels, and internal subagent-to-subagent delegations.
- **Why event-stream scraping failed**: If an agent implements custom authentication, external pull scrapers require storing end-user credentials. Furthermore, internal cron and subagent traffic carry no external HTTP credentials to scrape with.
- **Release-time injection**: Eveland injects an observer hook during compilation, pushing structured events directly from within the agent process via standard OTLP. The injection is self-contained and never alters user source code.

---

## 2. Private providers: Zero intrusion into user globals

The injected observer instantiates private, isolated OpenTelemetry providers:

- Does not register global `TracerProvider` or `MeterProvider` instances;
- Never flushes, alters, or terminates user-defined OTel instrumentation;
- User application telemetry continues reporting to user-configured backends independently.

---

## 3. Trust boundaries and provenance integrity

- **Two receivers, tiered trust**: The Collector publishes separate platform receivers (`17311`/`17312`) and agent receivers (`17313`/`17314`). The agent receiver accepts only restricted instrumentation scopes, preventing agents from impersonating platform services.
- **Server-side provenance verification**: The Worker signs unique deployment credentials; the built-in ingest service verifies attribution upon receipt, preventing agents from attributing telemetry to arbitrary projects.
- **External sink credential isolation**: Agents hold no external destination credentials (e.g. Elastic or Langfuse API keys); outbound fan-out is handled securely by the Collector through authenticated internal proxies.

---

## 4. Accepted engineering trade-offs

- **Availability over observability**: Telemetry pipeline backpressure gracefully degrades; **telemetry hiccups must never fail an active conversation turn**.
- **At-least-once delivery**: Network retries mean ingestion logic is designed to be fully idempotent.
- **Built-in storage as structured summary**: The built-in PostgreSQL store retains conversation trees, token usage, and instance metrics; deep span-level trace analysis is delegated to external APM destinations.

## Deeper reference

- [Observability behavior contract](/docs/reference/observability): OTLP batch storage, SessionNode projection rules, and retention policy
- [Sessions and usage tracking](/docs/observe/sessions): developer guide to SessionNode trees and usage reporting
- [Health and diagnostics](/docs/operations/diagnostics): verifying Collector health and troubleshooting missing usage
- [Architecture reference](/docs/reference/architecture): observation data path and telemetry flow diagrams
