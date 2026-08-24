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

## Sandbox injection and workspaces

An Eve deployment's built-in `bash`, `read_file`, `write_file`, `glob`, and `grep` must connect to an executable isolated sandbox — never silently degrading under production-style `eve start` to a `just-bash` missing its optional peer. The platform injects `@evelandhq/sandbox-bwrap` into the Release copy on both Docker and systemd. Release preparation must replace the user-authored sandbox backend while preserving the authored `bootstrap()`, `onSession()`, `description`, and `revalidationKey`: the injector renames the effective authored definition in place to a non-discovered companion module in the same directory, and the generated `sandbox.js` spreads its fields and overrides only `backend` last — so the original definition's relative-import semantics must not change.

Each project's durable session workspace lives outside the Release directory; a redeploy or restart must not lose the same Eve session's `/workspace`. The platform must also preserve `agent/sandbox/workspace/**`: these authored seeds continue to be compiled by Eve and initialized into `/workspace/**` for every new session, and must not be dropped from the Release because the platform chose the backend. Workspace templates must be isolated per immutable Release: after a sync-deploy updates the seeds, sessions created against the new Release use the new content, while existing durable sessions' `/workspace` must never be overwritten by a deploy.

The local Docker development container must not receive the Docker socket; the capability/seccomp additions for nested bwrap belong to the local Docker runtime only, and Linux production keeps the unprivileged systemd+bwrap boundary. The sandbox command baseline and the post-build self-check live in [Host prerequisites](/docs/production/prerequisites) and [Diagnostics](/docs/operations/diagnostics).

## Durable workflow world

Agents never configure or depend on the durable workflow world; Eveland owns the complete production boundary.

- The shared world is mandatory in production. Worker fails startup closed without `EVELAND_WORKFLOW_WORLD_URL`, and API reads the same variable (through `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL` when set) to learn the World's cluster identity from the database itself, refusing workflow-step activation while the registered dispatcher reports any other cluster. When `NODE_ENV` is not production and no workflow URL is configured, Eveland injects nothing and Eve keeps its local development world.
- The runner is external-only: `EVELAND_WORKFLOW_RUNNER` defaults to `external`, and an explicit `embedded` fails Worker startup closed. Exactly one [Workflow Dispatcher](/docs/production/workflow-dispatcher) runs alongside Worker for durable timers, wake, and continuation. It is single-instance and holds a PostgreSQL advisory lock for its lifetime; never run multiple replicas against the same shared database.
- The supported Eve window requires workflow spec v6. Every new Release injects `@evelandhq/workflow-world@0.13.1` through a generated wrapper that preserves the authored agent config while forcing `experimental.workflow.world`; the pinned world package is installed without touching the imported source, `package.json`, or lockfile. The legacy `@workflow/world-postgres@5.0.0-beta.34` world exists only in historical Releases and is never selected for a new build.
- Before any deployment process starts, Worker provisions that Project's partitions in the shared database; tenancy and cold-start recovery stay scoped by `tenant_id`. Worker startup and tenant provisioning apply every pending shared-World migration automatically, serialized by the package's advisory lock. Deployments of one Project intentionally share its workflow world (different Projects remain isolated), so an opaque task-input callback can resume through any compatible target.
- `WORKFLOW_POSTGRES_URL` is a reserved runtime name: a Project Secret with that name stays stored and log-masked, but it cannot redirect the platform world.
- The dispatcher owns shared-World maintenance: failure-isolated block packing and deadline-driven stream/run expiry at startup and every minute, bounded per pass by the `WORKFLOW_DISPATCHER_MAINTENANCE_*` variables, with snapshot-stripping compaction controlled by `EVELAND_WORKFLOW_STREAM_COMPACTION`. Normal deletes make pages reusable but do not guarantee immediate filesystem shrinkage.
- Every Release persists an immutable workflow attestation (world kind, package/version, storage spec, dispatch protocol, deployment-side enqueue capability), sourced from what release preparation actually injected — never from the Worker environment at record time; the runner mode is a startup input and not part of the attestation. Capability is a version fact of the world: early shared worlds without per-run enqueue attest as `unscoped`. An attestation is immutable once written, and historical rows migrate as `unknown`. Every start path — deploy start, restart, cold activation — decides solely on the persisted attestation: only Releases with a `shared` attestation may start; legacy or `unknown` objects return managed errors with the stable `workflow_migration_required`/`workflow_unavailable` prefixes and fail closed, never guessing from the current environment.
- Bootstrap is idempotent and unattended: a fresh empty database completes a full bootstrap without supervision, pending migrations on an existing schema are applied idempotently by Worker startup or tenant provisioning, and `runMigrations` serializes concurrent startups with a PostgreSQL advisory lock — no separate maintenance-window gate. When the host and deployments need different addresses for the same database, the host side always prefers the explicit bootstrap URL; when the deployment URL uses `host.docker.internal` and is otherwise identical to `DATABASE_URL`, Worker bootstrap reuses the already-reachable `DATABASE_URL` — the platform never guesses about any other database-address relationship.
- The stream storage boundary: the world by default strips accumulated snapshots reconstructible from deltas before writing, and creates server-side checkpoints every 128 logical chunks or 64 KiB; `writeMulti` packs at most 64 logical chunks and 256 KiB into one physical block, while readers still return compatible bytes by original logical chunk id and cursor. `EVELAND_WORKFLOW_STREAM_COMPACTION=off` is only an emergency switch for the write side and terminal block rewrites; readers always handle mixed old/new data. Deleting chunks outside the window means older raw cursors no longer guarantee replay.
- The legacy per-project physical databases (`eveland_wf_<project>_<digest>`, derived from the base `WORKFLOW_POSTGRES_URL`) remain only as historical data residue: legacy deployments can no longer start, and the Worker no longer derives or bootstraps derived databases for any start path; the base URL serves only as the admin connection for enumerating and deleting derived databases (the role needs `CREATEDB`), so it is no longer required in production and serves only installs still deleting legacy projects.
- A reverse proxy that routes by path in front of a deployment must forward **both** `/eve/` and `/.well-known/workflow/`. The world delivers run callbacks to `/.well-known/workflow/v1/flow`; forwarding only `/eve/` lets sessions start but stalls every run silently.

Defaults and semantics for every variable named here live in the [environment variable reference](/docs/reference/environment-variables).

## Workflow retention classes

The shared world applies exactly one complete policy chain to new runs: an explicit `retentionClass` beats the `workflow-world.retention-class` attribute, the attribute beats the Workflow SDK's `$rootRunId`/`$parentRunId` lineage, lineage beats the platform root invocation context, and only then does the `interactive` default apply. Child runs read the stored class of their same-tenant ancestor directly — never guessed from workflow names, timeouts, or callbacks; when lineage exists but cannot be resolved, it fails closed. Eve itself carries no Eveland-specific modification; an architecture gate reads `STABLE_WORKFLOW_NAMES` from the supported Eve release packages and must fail when a new stable internal workflow appears without updating the audit matrix.

The product contract per root source:

| Root source                                              | Default class                                       | Notes                                                          |
| -------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| Eveland Markdown Schedule creating a session             | `scheduled`                                         | platform-enforced; authored options cannot loosen it           |
| Eveland handler Schedule creating a target session       | `scheduled`                                         | cross-channel origin kept through owner resolution             |
| Schedule delivery to an existing session                 | keeps the existing root                             | continuations are not reclassified                             |
| Playground / public Eve HTTP / ordinary authored Channel | `interactive`                                       | Eveland only proxies, injecting no policy                      |
| Eve SDK session create, MCP/operation invocation         | `interactive`                                       | create-once and bindings never change the class                |
| Callback, follow-up, reset                               | existing root; re-selected when reset changes owner | lineage first; a new root follows the current source           |
| Direct/custom workflow start                             | explicit class, else `interactive`                  | no workflow name may serve as a policy basis                   |
| Reviewed durable product operations                      | `persistent`                                        | needs an observable owner/reason; never inferred from timeouts |

The cleanup schedule: scheduled/ephemeral runs become compactable 1 minute after terminal; successful runs drop non-EOF stream data after 15 minutes and the graph after 24 hours; failed runs keep them for 1 hour and 7 days; cancelled runs for 1 hour and 3 days; interactive (the default) for 5 minutes, 24 hours, and 30 days; persistent runs are never auto-deleted. Cleanup must judge by the full run lineage: while any descendant is still active, is persistent, holds a later deadline, or has a valid callback/hook capability, the whole graph must not be deleted. Active/waiting runs carry no deadline, and EOF markers are kept forever.

Historical repair is separate from forward correctness. An operator must first preview a single tenant's root/descendant graph and mismatches by the exact durable root trigger (currently `$eve.trigger = channel:eveland-scheduler`), then repair active graphs first in bounded batches; existing `persistent` rows are never rewritten, and terminal class updates recompute deadlines atomically via a database trigger against the original terminal timestamp. Afterwards only normal bounded maintenance runs — no unbounded deletes and no `VACUUM FULL`. Diagnostics group by tenant, resolved root trigger, run type, workflow name, status, and current class, reporting wrong root classes and child/root mismatches separately; backfilling from titles or the stable Eve workflow names themselves is forbidden.

## Recovery and reconciliation

Worker recovers interrupted activation jobs, reconciles database state with real processes, and sweeps orphan `eveland-*-dep_*` units. It can adopt a legitimate unmanaged process into the RuntimeInstance lifecycle or stop a process with no valid Deployment owner.

Never change the resolved runtime on a host with live deployments. Drain every target first; each Deployment must continue using the adapter recorded in its `runtimeKind`.

## Deleting a project

`DELETE /projects/:projectId` is asynchronous: like `build-deploy`, `sync-source`, and `restart`, it enqueues a job — `delete_project` — and returns `202` immediately. The request atomically persists `deletion_status = 'deleting'`; Dashboard keeps the Project visible as `Deleting…`, and mutating platform API requests return `409` until deletion finishes. Worker does not claim the deletion job while another job for the same Project is still running.

The job stops every `running` or `draining` Deployment first, resolving each adapter from the Deployment's recorded `runtimeKind`, then removes its runtime Release and the Project's platform-managed source, build, Agent observability policy, and sandbox directories. Only paths contained by `EVELAND_DATA_DIR` are eligible; an externally supplied source path is never recursively removed. Database records are deleted last. Deleting a project must also delete its legacy derived workflow databases (before the project row is deleted; a failed database drop must keep the deletion retryable) — derived databases must never remain as orphans — and drops that project's partitions in the shared database without scanning or deleting any other tenant's.

If a stop, Release removal, filesystem cleanup, or database operation fails, the Project remains with `deletion_status = 'failed'` and the error stays visible for retry. Runtime and filesystem cleanup is not a Postgres transaction, so some resources may already have been removed before a retry.
