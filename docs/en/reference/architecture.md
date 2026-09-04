---
title: Architecture reference
description: Review application ownership, dependency direction, data paths, and the public request flow.
---

![Eveland production topology](../../assets/topology-en.svg)

## 1. Component ownership and roles

| Component               | Execution Model               | Core Responsibility                                                                                |
| :---------------------- | :---------------------------- | :------------------------------------------------------------------------------------------------- |
| **Dashboard**           | Host process (unprivileged)   | Authenticated web console and interactive debugging interface.                                     |
| **API**                 | Host process (unprivileged)   | Platform contracts, metadata persistence, team auth, source imports, and built-in OTLP projection. |
| **Agent Gateway**       | Host process (`DynamicUser`)  | Public agent data plane, trusted routing, session affinity, and streaming transport.               |
| **Worker**              | Host service (`root`)         | Sandboxed build execution, systemd transient lifecycle, schedules, and orphan recovery.            |
| **Workflow Dispatcher** | Host service (`DynamicUser`)  | Singleton external scheduler driving durable timers, wake-ups, and step continuations.             |
| **OTel Collector**      | Container                     | Managed OTLP receiver, persistent disk queues, and fan-out to sinks.                               |
| **PostgreSQL**          | Container or external cluster | Control plane metadata and the single shared workflow world (tenant-partitioned).                  |

---

## 2. Dependency direction constraints

Eveland enforces strict one-way architectural boundaries, guarded by ratchet test suites:

```text
apps (Web, API, Gateway, Worker) ──> packages
packages/session-collector ─────────> packages/core + packages/db
packages/db ────────────────────────> packages/core
packages/core ──────────────────────> No internal Eveland package dependencies (Root package)
apps -X-> apps (Strictly forbidden: no app-to-app cross imports)
```

---

## 3. Public request flow

```text
External client request
  → Wildcard HTTPS host (*.agents.example.com)
  → Reverse proxy (Traefik terminates TLS)
  → Agent Gateway (Host port 17300, validates Host & Auth)
  → Routing policy / SessionBinding resolution
  → Private loopback deployment (127.0.0.1:18000–18999)
  → Eve HTTP channel execution
```

---

## 4. Observability and telemetry flow

```text
Agent execution / Platform service logs
  → Injected private OTel provider (preserves user instrumentation)
  → Pushed via OTLP to managed Collector
  → Built-in projection persists data to Postgres (Sessions, Usage, Instance Health)
  → (Optional) Fan-out to external telemetry stores (e.g. Elastic, Langfuse)
```

- **Retention windows**: Capacity metrics are retained for 30 days; derived Session and Usage records are kept for 90 days.

## Deeper reference

- [Production architecture overview](/docs/production): supported core services, host Worker, and systemd topology
- [Design decisions overview](/docs/reference/design): full collection of architectural trade-offs
- [Why systemd, not Docker](/docs/reference/design/runtime): runtime selection and host density rationale
- [Agent Gateway invariants](/docs/reference/design/gateway): data-plane rules and security boundaries
