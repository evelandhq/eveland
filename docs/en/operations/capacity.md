---
title: Capacity planning
description: Map single-host machine size to concurrent builds, running Agents, and the Postgres connection budget.
---

Eveland runs a fleet of Agents on one machine, so the practical question is how machine size maps to concurrent workload. Three workload kinds compete for the host, in decreasing memory weight:

| Workload                                                                   | Memory (typical) | CPU                     | Postgres connections                                                                      |
| -------------------------------------------------------------------------- | ---------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| One **build** (`npm ci`/`npx eve build`)                                   | 1–2 GB peak      | high (bursts, ~2 cores) | none — the build environment deliberately excludes all database URLs                      |
| One **running Agent** (`npx eve start`)                                    | 150–300 MB RSS   | low while idle          | up to `WORKFLOW_POSTGRES_MAX_POOL_SIZE` (default 10) + platform request load it generates |
| Core services (API, Agent Gateway, Dashboard, Worker, Postgres, Collector) | ~1–1.5 GB total  | low                     | ~30 (`DATABASE_POOL_SIZE` × API/Agent Gateway/Worker)                                     |

## Concurrency governance

- **Running Agents**: no hard cap. The idle reaper stops any Agent with no activation lease for five minutes (`EVELAND_ACTIVATION_IDLE_TTL_MS`), so the steady-state count follows real traffic, not the number of Projects.
- **Builds**: at most one running job **per Project**, plus a global cap on concurrently running builds. Worker derives the cap from the machine at startup — `max(1, min(⌊RAM / 4 GiB⌋, cores − 2))`, matching the reference table below — and logs it at boot; `EVELAND_MAX_CONCURRENT_JOBS` overrides it. Builds beyond the cap stay queued while cheap jobs (restart, archive, delete, import) keep flowing. The Worker admits jobs through a bounded pump: up to `WORKER_JOB_CONCURRENCY` claimed jobs execute at once (derived `max(1, min(cores − 1, 3))`), claiming back-to-back while the queue is non-empty and only pausing `WORKER_POLL_INTERVAL_MS` (default 5 s) when it is empty. Enqueues additionally wake an idle pump immediately via Postgres `NOTIFY`; polling remains the correctness fallback, so a lost notification only costs latency. Latency-sensitive jobs — Deployment activations and schedule dispatches, which race Eve's 30-second command-hook wait — claim ahead of queued builds and imports. The **Settings → Instance health** Workload section shows current usage as "Running builds N/cap".

## Postgres connection budget

`max_connections` is the limit operators reach first (`FATAL 53300: sorry, too many clients already` at Agent startup), but **connections are a bookkeeping ceiling, not the scarce resource**. Raising `max_connections` costs almost nothing until connections actually exist, and an idle backend is roughly 2 MB — 300 mostly-idle connections is under 1 GB. The Agents _holding_ those connections cost far more than the connections themselves, so RAM runs out at the process level first. Size in this order:

1. Budget RAM: `total − 2 GB (OS + core services) − builds × 2 GB`, then divide by ~0.3 GB for the sustainable running-Agent count.
2. Set `max_connections ≈ agents × WORKFLOW_POSTGRES_MAX_POOL_SIZE + 30 (core services) + WORKFLOW_DISPATCHER_POOL_SIZE + headroom`. Lower the per-Agent pool size to fit more Agents per instance when workflows are light. The dispatcher's pool (10 by default) is a **flat** cost: it does not grow with the Agent count, and raising `WORKFLOW_DISPATCHER_CONCURRENCY` to run more dispatches at once does not raise it either — a dispatch held open waiting on an Agent occupies a socket, not a connection.

## Reference table

The "Concurrent builds" column is what Worker's derived cap enforces on a typical host of that size — memory-bound at one build per 4 GB, limited to cores − 2 on CPU-lean machines:

| Host  | Concurrent builds | Running Agents | `max_connections` |
| ----- | ----------------- | -------------- | ----------------- |
| 4 GB  | 1                 | ~5             | default 100       |
| 8 GB  | 2                 | ~10–15         | 200               |
| 16 GB | 3–4               | ~30            | 300–400           |
| 32 GB | 6–8               | ~60            | 400+ (pool 5)     |

## Per-deployment ceilings

Each Deployment cgroup is bounded by `EVELAND_MEMORY_MAX`, `EVELAND_CPU_QUOTA`, and `EVELAND_TASKS_MAX`, and each sandbox command by the `EVELAND_SANDBOX_*` budgets — see [Runtime and resources](/docs/operations/runtime) for how the adapters apply them and the [environment variable reference](/docs/reference/environment-variables) for defaults. Multiply the memory ceiling by the expected concurrent running Agents when it is far above the typical 150–300 MB RSS: the ceiling caps a runaway process, it does not reserve memory.

## Disk and network capacity

- The sandbox cache below `EVELAND_SANDBOX_CACHE_DIR` grows with durable sessions and unique templates and is not pruned automatically. The vendored backend exposes dry-run-first list/prune APIs; inspect a dry run before applying deletion, and never delete hash-named directories by hand.
- Release artifacts are bounded by the retention sweep (`EVELAND_RELEASE_RETENTION`, newest releases and active targets protected).
- On the local Docker runtime, each active Deployment consumes one bridge subnet; capacity is bounded by Docker's configured `default-address-pools` (the recommended `/16` split into `/24` networks permits 256 concurrent managed networks).

## Deeper reference

- [Why systemd, not Docker](/docs/reference/design/runtime): runtime selection and host density rationale
- [Scale-to-zero design decisions](/docs/reference/design/scale-to-zero): idle process teardown and on-demand activation
- [Runtime and resources](/docs/operations/runtime): cgroup resource ceilings and sandbox execution budgets
- [Environment variables](/docs/reference/environment-variables): concurrency and capacity environment knobs
