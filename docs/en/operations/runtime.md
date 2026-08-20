---
title: Runtime and resources
description: Control process lifetime, cold activation, CPU, memory, the durable workflow world, and orphan recovery on a production host.
---

Eveland separates durable deployment identity from process lifetime. A Deployment can keep its Release, preview Host, routes, and SessionBindings while its RuntimeInstance is stopped.

## Activation lifecycle

Public requests, continuations, streams, and schedules acquire an ActivationLease before reaching a process. If the target is dormant, API coalesces one activation job and Worker starts the exact Release with its persisted runtime adapter. The Agent Gateway waits only for the configured cold-start window.

After the final lease ends, Worker waits for `EVELAND_ACTIVATION_IDLE_TTL_MS`, checks again for new protection, then stops only the process. Upcoming or non-terminal ScheduleRuns protect their pinned target.

## How a deployment runs

- **Build.** The imported source is copied to `builds/<project>/<release>` below `EVELAND_DATA_DIR`; Eveland injects its reserved telemetry hook, the workflow-world wrapper, and the sandbox modules into that copy, never into the imported source. Dependency install and `npx eve build` run as the unprivileged build user inside the build sandbox. Builds select a pnpm frozen install for `pnpm-lock.yaml`, `npm ci` for `package-lock.json`, and `npm install` only when no lockfile exists.
- **Run.** systemd starts the transient unit `eveland-<project>-<deployment>.service` under a deterministic per-Deployment dynamic user with `ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`, and write access only to the release directory and the sandbox cache. The process binds `127.0.0.1:<hostPort>`; secrets arrive through a root-owned `0600` `EnvironmentFile` and never through unit properties.
- **Health.** Worker polls `http://127.0.0.1:<hostPort>/eve/v1/health` until any HTTP response arrives. On timeout it captures bounded unit state and journal output, masks Project Secret values, and persists that diagnostic before stopping the unit.
- **Idle.** A dormant Deployment keeps its immutable Release, routes, and SessionBindings. If the imported source directory was already reclaimed, cold and schedule activation recover the package-manager selection from the immutable SourceRevision's persisted manifest metadata. An explicit restart remains live-source-only and fails before stopping the current process when that directory is missing.

## Per-deployment limits

Both runtime adapters apply `EVELAND_MEMORY_MAX`, `EVELAND_CPU_QUOTA`, and `EVELAND_TASKS_MAX` to each Deployment cgroup. Docker maps them to `--memory`, `--cpus`, and `--pids-limit`; systemd maps them to `MemoryMax`, `CPUQuota`, and `TasksMax`. Injected bwrap `run()` commands also stop after `EVELAND_SANDBOX_RUN_TIMEOUT_MS` (10 minutes by default), while authored long-running processes must use `spawn()`. Choose limits that leave headroom for builds, Postgres, the core services, and concurrent cold starts — see [Capacity planning](/docs/operations/capacity).

## Durable workflow world

Agents never configure or depend on the durable workflow world; Eveland owns the complete production boundary.

- The shared world is mandatory in production. Worker fails startup closed without `EVELAND_WORKFLOW_WORLD_URL`, and API reads the same variable (through `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL` when set) to learn the World's cluster identity from the database itself, refusing workflow-step activation while the registered dispatcher reports any other cluster. When `NODE_ENV` is not production and no workflow URL is configured, Eveland injects nothing and Eve keeps its local development world.
- The runner is external-only: `EVELAND_WORKFLOW_RUNNER` defaults to `external`, and an explicit `embedded` fails Worker startup closed. Exactly one [Workflow Dispatcher](/docs/production/workflow-dispatcher) runs alongside Worker for durable timers, wake, and continuation. It is single-instance and holds a PostgreSQL advisory lock for its lifetime; never run multiple replicas against the same shared database.
- The supported Eve window requires workflow spec v6. Every new Release injects `@evelandhq/workflow-world@0.12.0` through a generated wrapper that preserves the authored agent config while forcing `experimental.workflow.world`; the pinned world package is installed without touching the imported source, `package.json`, or lockfile. The legacy `@workflow/world-postgres@5.0.0-beta.34` world exists only in historical Releases and is never selected for a new build.
- Before any deployment process starts, Worker provisions that Project's partitions in the shared database; tenancy and cold-start recovery stay scoped by `tenant_id`. Worker startup and tenant provisioning apply every pending shared-World migration automatically, serialized by the package's advisory lock. Deployments of one Project intentionally share its workflow world (different Projects remain isolated), so an opaque task-input callback can resume through any compatible target.
- `WORKFLOW_POSTGRES_URL` is a reserved runtime name: a Project Secret with that name stays stored and log-masked, but it cannot redirect the platform world.
- The dispatcher owns shared-World maintenance: failure-isolated block packing and deadline-driven stream/run expiry at startup and every minute, bounded per pass by the `WORKFLOW_DISPATCHER_MAINTENANCE_*` variables, with snapshot-stripping compaction controlled by `EVELAND_WORKFLOW_STREAM_COMPACTION`. Normal deletes make pages reusable but do not guarantee immediate filesystem shrinkage.
- A reverse proxy that routes by path in front of a deployment must forward **both** `/eve/` and `/.well-known/workflow/`. The world delivers run callbacks to `/.well-known/workflow/v1/flow`; forwarding only `/eve/` lets sessions start but stalls every run silently.

Defaults and semantics for every variable named here live in the [environment variable reference](/docs/reference/environment-variables).

## Recovery and reconciliation

Worker recovers interrupted activation jobs, reconciles database state with real processes, and sweeps orphan `eveland-*-dep_*` units. It can adopt a legitimate unmanaged process into the RuntimeInstance lifecycle or stop a process with no valid Deployment owner.

Never change the resolved runtime on a host with live deployments. Drain every target first; each Deployment must continue using the adapter recorded in its `runtimeKind`.

## Deleting a project

`DELETE /projects/:projectId` is asynchronous: like `build-deploy`, `sync-source`, and `restart`, it enqueues a job — `delete_project` — and returns `202` immediately. The request atomically persists `deletion_status = 'deleting'`; Dashboard keeps the Project visible as `Deleting…`, and mutating platform API requests return `409` until deletion finishes. Worker does not claim the deletion job while another job for the same Project is still running.

The job stops every `running` or `draining` Deployment first, resolving each adapter from the Deployment's recorded `runtimeKind`, then removes its runtime Release and the Project's platform-managed source, build, Agent observability policy, and sandbox directories. Only paths contained by `EVELAND_DATA_DIR` are eligible; an externally supplied source path is never recursively removed. Database records are deleted last.

If a stop, Release removal, filesystem cleanup, or database operation fails, the Project remains with `deletion_status = 'failed'` and the error stays visible for retry. Runtime and filesystem cleanup is not a Postgres transaction, so some resources may already have been removed before a retry.
