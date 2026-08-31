---
title: Workflow dispatcher
description: Install the single external workflow dispatcher that drives durable timers, wake, and continuation.
---

Durable workflows run in external mode only: `EVELAND_WORKFLOW_RUNNER` defaults to `external`, and an explicit `embedded` fails Worker startup closed. Deployments never claim their own workflow jobs, so exactly one workflow dispatcher must run alongside the Worker — without it, durable timers, wake, and continuation never fire.

## What it does

The dispatcher claims durable workflow jobs from the shared workflow database and POSTs each step back into the owning Agent Deployment, activating it first through the Control API when it has been idle-reaped — exactly as the Agent Gateway's cold start does. It never reaches into Worker internals, never touches Deployment files, and must never load tenant code: it talks to Postgres and to loopback HTTP only, and runs unprivileged under a systemd `DynamicUser`.

The dispatcher is single-instance: it holds a PostgreSQL advisory lock for its lifetime. Never run multiple dispatcher replicas against the same shared workflow database. Restarting is cheap and safe — every claim lives in Postgres, so a restart is a brief pause plus boot recovery, never lost work.

## Install the service

The dispatcher runs from the same `/opt/eveland` checkout as the Worker, at the same `vX.Y.Z` tag:

```bash
sudo install -d -m 0750 /etc/eveland
sudo cp infra/systemd/eveland-workflow-dispatcher.env.example /etc/eveland/eveland-workflow-dispatcher.env
sudo cp infra/systemd/eveland-workflow-dispatcher.service /etc/systemd/system/
```

Configure the environment file before starting the service, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eveland-workflow-dispatcher
```

The process prints `workflow-dispatcher: ready` on stdout once it is dispatching. The unit caps restarts (`StartLimitIntervalSec`/`StartLimitBurst`), so a broken configuration surfaces as a failed unit instead of an infinite crash loop.

## Configure the environment file

`infra/systemd/eveland-workflow-dispatcher.env.example` documents every entry. The values that must agree with other components:

- `EVELAND_WORKFLOW_WORLD_URL` — must be the same value the Worker injects into Deployments, or the dispatcher claims from a database nothing writes to. Set `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL` when Deployments reach Postgres by a different name than the platform's own processes do.
- `EVELAND_WORKFLOW_STREAM_COMPACTION` — must match the Worker's value so write-side and terminal-rewrite compaction follow the same policy.
- `WORKFLOW_DISPATCHER_ACTIVATION_API_URL` (normally `http://127.0.0.1:17301`) and `WORKFLOW_DISPATCHER_ACTIVATION_TOKEN` — the Control API and its internal service token; the token must match the API's value.
- `EVELAND_SCHEDULER_RUNTIME_SECRET` — must match the Worker's value: it is injected into every Deployment, whose workflow world uses it to authenticate inbound dispatch.
- `EVELAND_OTLP_ENDPOINT`, `EVELAND_OTLP_SERVICE_TOKEN` — the Collector's platform receiver.
- `NODE_ENV=production`, `EVELAND_RELEASE_CHANNEL`, `EVELAND_REVISION` — aligned with the other services.

Tuning shares the `WORKFLOW_DISPATCHER_*` prefix: `CONCURRENCY`, `POOL_SIZE`, `MAX_INFLIGHT_PER_TENANT`, `DISPATCH_TIMEOUT_MS`, `QUEUE_GC_INTERVAL_MS`, and the bounded `MAINTENANCE_*` family. The defaults suit a single host; raise the in-flight cap only after checking the workflow database's connection budget in [Capacity planning](/docs/operations/capacity). One constraint is enforced: `WORKFLOW_DISPATCHER_LEASE_RENEW_INTERVAL_MS` must stay well under the API's `EVELAND_ACTIVATION_LEASE_TTL_MS`, or a step longer than the lease loses its executor mid-flight — the dispatcher refuses to start at or above the TTL. Full definitions are in the [environment-variable reference](/docs/reference/environment-variables).

## Registration and revision alignment

The dispatcher reports a machine-readable registration (state, ownership, boot recovery, protocol window) to the Control API on a heartbeat. That registration — never systemd `active` or the stdout token — is what production deploys and workflow-step activation gate on: a stale or missing registration fails shared builds and `workflow_step` activation closed with `workflow_unavailable`.

Before starting the runner and performing boot recovery, the dispatcher must wait for the Platform API's public `/health` to succeed — parallel-process startup ordering is never carried by a Graphile job's first failure; once the health gate opens, activation, executor dispatch, and retry semantics remain the dispatcher's. After acquiring the lifetime advisory lock, the dispatcher first collects the old Graphile worker ids from the exact `wfrun:<tenant>:<run>` queues of active runs and force-unlocks them, then re-enqueues, and only then starts the new worker pool. A second dispatcher must fail closed; on upgrades the operator must stop the old process first — never inferring from a fresh lock that the old generation exited, and never skipping the per-run queueName or bulk-clearing all queue locks.

The registration is reported by the dispatcher that actually holds the ownership lock, over a service-authenticated heartbeat: instance/generation, ownership, boot-recovery completion, world cluster identity, schema generation, the dispatch-protocol window, state, and time. The cluster identity is `cluster:<pg system_identifier>/<database>` read from the database itself (never containing credentials), compared with strict equality on both sides — URL/host-shaped comparison fails open across unrelated clusters and is forbidden. In production both shared builds and `workflow_step` activation fail closed on that registration's freshness (`EVELAND_WORKFLOW_DISPATCHER_HEARTBEAT_TTL_MS`); a `workflow_step` activation caller must additionally carry, in the `x-eveland-dispatcher-instance` header, the exact instance id of that registration — binding the process that passed the readiness gate, not any holder of the service token — with a mismatch returning 409. Activation further requires the target Release attestation to be `shared`, the enqueue capability `per_run_queue_v1`, and the dispatch protocol to fall inside the window the registration declares (protocol and storage are independent axes; out-of-window storage likewise returns a `workflow_migration_required` 409); when the dispatcher cannot be proven, a 503 with the `workflow_unavailable` prefix is returned. The `workflow_step` activation response carries the negotiation result (selected protocol and enqueue capability).

Keep `EVELAND_REVISION` and `EVELAND_RELEASE_CHANNEL` identical to the Dashboard, API, Agent Gateway, and Worker, and restart the dispatcher from `/opt/eveland` on every upgrade. The dispatcher also owns bounded shared-world maintenance (stream block packing, deadline-driven expiry) — see [Runtime operations](/docs/operations/runtime) for how the durable World behaves in service.

Next, [configure Agent traffic](/docs/production/networking).

## Deeper reference

- [Workflow architecture design decisions](/docs/reference/design/workflow): external dispatcher and purpose-built shared Workflow World rationale
- [Runtime and resources](/docs/operations/runtime): durable workflow world tenant partitioning and retention classes
- [Configuration reference](/docs/reference/configuration): dispatcher environment variable list and concurrency parameters
