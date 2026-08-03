# `@eveland/workflow-world` — platform workflow orchestration

- **Status**: direction approved, ready to implement incrementally
- **Date**: 2026-08-03
- **Source**: design discussion (Michael + Claude); supersedes the per-project `eveland_wf_*` database architecture from PR #67 via a run-out migration
- **One-liner**: move workflow _orchestration_ (queue, claim, timers, retries, state) into a shared platform service; workflow _execution_ stays inside each agent deployment. "A Sidekiq that doesn't run your code" — the Cloud Tasks / Inngest shape, and the same shape as Vercel's own hosted world (`resolveWorkflowWorldImport` special-cases `local` and `vercel`).

## 1. Why

1. **Correctness (the headline)**: durable-workflow timers live as graphile `run_at` jobs inside each project's workflow DB, and the only runner lives inside the agent process. The idle reaper (`EVELAND_ACTIVATION_IDLE_TTL_MS`, default 5 min) kills that runner. A `sleep 1h` workflow on a quiet project resumes only when unrelated traffic or cron happens to wake the agent — potentially never. A platform-resident claimer fixes this structurally and unlocks real scale-to-zero.
2. **A second latent incident**: deployment retention (`getDeploymentRetention`, [postgres-deployment-routing-store.ts:690](../../packages/db/src/postgres-deployment-routing-store.ts)) protects only `route_target | active_session | active_request | recent_artifact`. Workflow runs are invisible to it, and [archive-deployment.ts](../../apps/worker/src/jobs/runtime-jobs/archive-deployment.ts) `rm -rf`s the build dir and removes the image. A pinned sleeping run outside the keep-3 window loses its executor.
3. **Capacity**: per-agent floor is ~2 held PG connections (graphile LISTEN + streamer's out-of-pool LISTEN client), ceiling `WORKFLOW_POSTGRES_MAX_POOL_SIZE` (10) + 1. Sizing is `agents × 10 + 30` (docs/deploy/linux.md) — the 53300 incident curve. pgbouncer transaction mode is **not** a cheap alternative here: both graphile and the streamer depend on LISTEN/NOTIFY.
4. **Strategy**: eveland grows Vercel-shaped; workflow/cron/connect become platform primitives sharing one durable-dispatch foundation. Cron already works this way (see §4 "scheduler blueprint").

## 2. Decisions ledger (all settled — do not re-litigate)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Orchestration centralizes; **execution stays in deployments**. The platform never loads tenant bundles.                                                                                                                                                                                                                                                                                                                 |
| D2  | New package **`@eveland/workflow-world`** (public npm, `0.x`, experimental banner) implements eve's `World` interface (`Queue & Storage & Streamer` from `@workflow/world`). Injected at build time exactly like world-postgres today ([workflow-world.ts:5](../../apps/worker/src/runtime/workflow-world.ts) `PLATFORM_WORKFLOW_WORLD` flips once).                                                                    |
| D3  | **Natively multi-tenant**: one shared Postgres database for all projects. No more per-project `eveland_wf_*` databases (legacy ones drain via run-out, §11 Phase 4).                                                                                                                                                                                                                                                    |
| D4  | **graphile-worker 0.16.6 stays** as the queue substrate, now a first-party pinned dependency. Verified in the installed package: `forbiddenFlags` accepts a per-claim function (`dist/worker.js:95-103`), `addJob` takes `flags text[]` (`dist/helpers.js:20`), `workerUtils.forceUnlockWorkers(workerIds)` exists.                                                                                                     |
| D5  | **Run affinity**: new runs target the currently promoted deployment; in-flight runs are pinned to the deployment that created them. Runs must record a **real** `deploymentId` (world-postgres hardcodes `getDeploymentId() → 'postgres'`).                                                                                                                                                                             |
| D6  | **Dispatcher is a separate resident app** (new `apps/` entry + systemd unit), not a worker module. Activation goes through the existing internal API (`POST /internal/runtime/activations`, [app-internal-routes.ts:92](../../apps/api/src/app-internal-routes.ts); gateway is the precedent client via [activation-client.ts](../../apps/gateway/src/activation-client.ts)) — never by reaching into worker internals. |
| D7  | **Data flow**: agents and the dispatcher never message each other directly — they rendezvous in shared Postgres. The only direct connection is dispatcher→agent: one held vqs POST per in-flight step (sync-hold v1; async-ack 202+callback is a later evolution). POST return = job complete. Zero standing connections when idle.                                                                                     |
| D8  | **Migration = run-out, no data migration.** World choice is a build-time property of the deployment, so old (world-postgres) and new deployments coexist by construction. A per-project flag governs the _next_ build; rollback = rebuild with the flag off.                                                                                                                                                            |
| D9  | Tenant boundary v1 is WHERE-clause discipline (accident-level, acceptable for the single-operator platform). Threat model documented; RLS + `SET ROLE` optional hardening; the real boundary is future HTTP storage (§14).                                                                                                                                                                                              |

## 3. Target architecture — the life of one step

```mermaid
sequenceDiagram
    participant A as agent deployment<br/>(eve executor + @eveland/workflow-world)
    participant PG as shared Postgres<br/>(control tables + partitions + graphile)
    participant D as workflow dispatcher<br/>(resident app)
    A->>PG: world.queue.send → add_job(flags=[project:X], payload={ids}, run_at)
    D->>PG: graphile claim (LISTEN/NOTIFY + 500ms, forbiddenFlags skips capped projects)
    D->>D: affinity: run.deploymentId → activation lease → endpointPort
    D->>A: vqs POST /.well-known/workflow/v1/{flow,step} (held for step duration)
    A->>PG: executor runs step; storage/events/stream chunks written directly
    A-->>D: 200 {ok:true} → job complete (fail → maxAttempts 3 + backoff)
```

**One sentence**: PG is the rendezvous, the dispatcher is the only active party, agents only receive POSTs and write to the DB.

Two ids, two roles: `projectId` = tenancy (data scoping, fairness flags, deletion drain); `deploymentId` = affinity (in-flight runs pin their executor; new runs follow promote).

## 4. Verified facts — do not re-explore these

Package internals were read from the parent checkout's `node_modules` (pnpm store); eveland refs are repo paths.

**world-postgres `5.0.0-beta.25`** (the thing being replaced; also the porting source):

- Composition: `createClient(pool)` + `createQueue(config, pool)` + `createStorage(drizzle)` + `createStreamer(pool, drizzle)` — `dist/index.js:31-39`; startup `queue.start(); reenqueueActiveRuns(storage.runs, queue.queue, 'world-postgres', config.namespace)` at `:48-51` (namespace is unset in eveland — physical DB separation is the _sole_ isolation today; **PR #67's root cause lives here**).
- Queue/exec split already exists: the graphile task handler POSTs vqs messages over HTTP to the local eve executor (`executeMessageOverHttp`, `dist/queue.js:210-233`; headers `x-vqs-queue-name` / `x-vqs-message-id` / `x-vqs-message-attempt`; route `flow`|`step`; base URL from `WORKFLOW_LOCAL_BASE_URL` → `config.port` → `PORT`, `:118-136`). Runner: `run({concurrency: 50, pollInterval: 500})` `:449-471`. `createQueueHandler` (executor side) is delegated to `@workflow/world-local` `:76` — that side is eve's, we keep it.
- Idempotent enqueue: `jobKey = idempotencyKey ?? messageId`, `maxAttempts: 3` (`dist/queue.js:97-115, 351`).
- `getDeploymentId()` returns the literal `'postgres'` (`dist/queue.js:76-78`); world-local returns `dpl_local@<version>`. Neither is a real deployment id — D5's concrete gap.
- Streamer: dedicated out-of-pool `new Client(pool.options)` LISTENing on channel `workflow_event_chunk`, publish via `pg_notify` (`dist/streamer.js:38-62, 81-102`). **In a shared DB this channel becomes a global broadcast — channel names must be tenant-scoped (e.g. suffix projectId).**

**The eve compatibility gate — previously "unverified", now settled** (eve `0.29.5`, which bundles `@workflow/world@5.0.0-beta.23`; world-postgres pins `beta.19`):

- `validateWorkflowWorld({ world, packageName })` (`dist/src/internal/workflow/validate-world.js`) does exactly two things:
  1. **Version-line check** (`assertWorkflowWorldCompatibility`, `dist/src/internal/workflow/world-compatibility.js`): resolves `<packageName>/package.json`, reads the first of `@workflow/core` then `@workflow/world` from `dependencies ?? peerDependencies`, and compares **major** + **prerelease tag** against the `@workflow/core` version eve bundles. It throws only on a _definite_ line mismatch (different major, or both tagged and tags differ). If the manifest can't be resolved, or declares neither package, it silently passes.
  2. **Duck-type check** (`isWorkflowWorld`): `createQueueHandler` is a function, `events` is a non-null object, `specVersion` is a number. Nothing else about the interface is checked at config time.
- The real gate is at runtime, not config time: eve compiles a **literal** `if (world.specVersion !== 5) throw` (`dist/src/compiled/_chunks/workflow/wait-until-*.js`). The constant is baked per eve release, so every eve bump must re-verify it.
- Consequence for us: `@eveland/workflow-world` must declare `@workflow/world` (or `@workflow/core`) at `5.0.0-beta.*` and report `specVersion: 5`. Both are cheap to assert in CI (§12).
- `resolveWorkflowWorldImport` (`dist/src/internal/workflow/world-target.js`) maps only `local` and `vercel` to package names; any other string is passed through as a bare import specifier — which is exactly how our package name gets injected.

**The vqs endpoint — Phase 0b is already answered, and it is a finding:**

- Path is `POST <origin>/.well-known/workflow/v1/flow` (or `/step`), built by `createWorkflowUrl` (`@workflow/utils/dist/workflow-routes.js:1,14-20`); route is `flow` for the workflow queue kind and `step` for the step kind.
- **It is publicly reachable through the gateway today**, and that is asserted as intended behavior by [app-streaming.test.ts:162-177](../../apps/gateway/src/app-streaming.test.ts) — a request to `http://p-alpha.agent.localhost/.well-known/workflow/v1/flow` is proxied to the deployment.
- **The handler is unauthenticated**: `createQueueHandler` (`@workflow/world-local/dist/queue.js:290-322`) validates only that the three `x-vqs-*` headers parse and that the queue name starts with the expected prefix. There is no secret, signature, or origin check.
- This is a live injection surface independent of this project: anyone who can reach a project's public hostname can POST vqs messages at its executor. **Fix before Phase 2** (Phase 2 makes the platform a legitimate caller of the same endpoint, so the fix has to distinguish dispatcher traffic from public traffic — see §7). Tracked as its own issue, not as a workflow-world deliverable.

**eveland wiring**:

- Build-time injection: [prepare-release.ts:29](../../apps/worker/src/runtime/prepare-release.ts) → `injectWorkflowWorld` ([workflow-world.ts:36-114](../../apps/worker/src/runtime/workflow-world.ts)) rewrites agent config (`experimental.workflow.world`), installs the package in [docker.ts:225](../../apps/worker/src/runtime/docker.ts) / [systemd.ts:187](../../apps/worker/src/runtime/systemd.ts).
- Env injection + reserved keys: [process-support.ts:248-262](../../apps/worker/src/jobs/process-support.ts), [reserved-environment.ts:21-34](../../apps/worker/src/runtime/reserved-environment.ts) (`WORKFLOW_POSTGRES_URL`, `WORKFLOW_POSTGRES_MAX_POOL_SIZE`; add `EVELAND_PROJECT_ID`, `EVELAND_DEPLOYMENT_ID`).
- Per-project DB provisioning/teardown (legacy path, stays during run-out): [workflow-world-bootstrap.ts](../../apps/worker/src/runtime/workflow-world-bootstrap.ts) (`eveland_wf_<safe>_<sha6>`, `drop database … with (force)` from [delete-project.ts:69](../../apps/worker/src/jobs/runtime-jobs/delete-project.ts)); chunk retention sweeper [workflow-world-reaper.ts](../../apps/worker/src/runtime/workflow-world-reaper.ts) enumerates DBs by prefix.
- **Activation is lease-based, and the lease is load-bearing for us** ([app-internal-routes.ts:92-147](../../apps/api/src/app-internal-routes.ts)): `POST /internal/runtime/activations` returns `{ lease, runtimeInstance }`, and `runtimeInstance.endpointPort` is the port to talk to — so affinity resolution comes back _from the activation call itself_, no separate deployment-row port lookup on that path. Lease TTL `EVELAND_ACTIVATION_LEASE_TTL_MS` (default 180 000 ms) with `POST …/:leaseId/renew` and `DELETE …/:leaseId`; cold-start wait bounded by `EVELAND_COLD_START_TIMEOUT_MS` (default 30 000 ms). Failure codes: `409` not activatable (archived/failed), `425` draining (the gateway client retries this one), `503` unavailable, `504` activation timeout.
- **The scheduler blueprint** (mirror this shape for dispatch): planner tick → `claimDueScheduleRuns` (`FOR UPDATE SKIP LOCKED`, [postgres-schedule-store.ts:325](../../packages/db/src/postgres-schedule-store.ts)) → [trigger-schedule.ts](../../apps/worker/src/jobs/runtime-jobs/trigger-schedule.ts) validates, `ensureDeploymentActive`, then POST `http://127.0.0.1:<hostPort>/eveland/scheduler/:id` with `authorization` + `x-eveland-runtime-secret` ([process-support.ts:27-45](../../apps/worker/src/jobs/process-support.ts)); channel injected at build time by [agent-scheduler/adapter.ts](../../packages/agent-scheduler/src/adapter.ts).
- Fairness precedent: machine-derived global cap [job-concurrency.ts:17-22](../../apps/worker/src/runtime/job-concurrency.ts) (`min(mem/4GiB, cores-2)`, `EVELAND_MAX_CONCURRENT_JOBS` override) — reuse the idea inside the `forbiddenFlags` callback.
- Reachability: deployments are loopback TCP on allocated host ports (base `EVELAND_DEPLOYMENT_PORT` 41000, [ports.ts](../../apps/worker/src/runtime/ports.ts)); ports persisted on deployment + runtime_instances rows.

## 5. The `World` surface we implement

`World extends Queue, Streamer, Storage` (`@workflow/world/dist/interfaces.d.ts`). Everything below is the complete member list; "port" means translate world-postgres's drizzle implementation and add the tenant predicate.

| Member                                                               | Required | v1                                                                                                                                       |
| -------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `queue(queueName, message, opts)`                                    | yes      | graphile `add_job` with `flags: ['project:<id>']`, `jobKey = idempotencyKey ?? messageId`, `maxAttempts: 3`, `runAt` from `delaySeconds` |
| `getDeploymentId()`                                                  | yes      | returns `EVELAND_DEPLOYMENT_ID` — the D5 fix                                                                                             |
| `createQueueHandler(prefix, handler)`                                | yes      | **executor side**: delegate to `@workflow/world-local`, exactly as world-postgres does                                                   |
| `streams.write` / `close` / `get` / `list` / `getChunks` / `getInfo` | yes      | port; NOTIFY channel suffixed with the tenant id                                                                                         |
| `streams.writeMulti`                                                 | no       | skip — Postgres batching is not the bottleneck; revisit with the §15 chunk-volume work                                                   |
| `streamFlushIntervalMs`                                              | no       | leave at eve's 10 ms default                                                                                                             |
| `runs.get` / `runs.list`                                             | yes      | port + tenant predicate                                                                                                                  |
| `runs.experimentalSetAttributes`                                     | no       | port it — world-postgres has it, and dropping it silently degrades `setAttributes` to a no-op                                            |
| `steps.get` / `steps.list`                                           | yes      | port + tenant predicate                                                                                                                  |
| `events.create` / `get` / `list` / `listByCorrelationId`             | yes      | port + tenant predicate; `events.create` is the only write path for state                                                                |
| `hooks.get` / `getByToken` / `list`                                  | yes      | port + tenant predicate — see the `getByToken` note below                                                                                |
| `specVersion`                                                        | yes      | literal `5`; asserted in CI against the installed eve (§12)                                                                              |
| `start()`                                                            | no       | ours: start the runner (embedded mode only) + **tenant-scoped** re-enqueue, never `reenqueueActiveRuns`                                  |
| `close()`                                                            | no       | implement — CLI/short-lived processes rely on it to exit cleanly                                                                         |
| `analytics`                                                          | no       | skip v1                                                                                                                                  |
| `processExitTriggersQueueRedelivery`                                 | no       | **leave false** — see below                                                                                                              |
| `resolveLatestDeploymentId()`                                        | no       | **implement** — this is the promote-follows hook                                                                                         |
| `getEncryptionKeyForRun()`                                           | no       | not v1 — payloads stay unencrypted, same as today; noted as future hardening in §15                                                      |

Three of these deserve reasons rather than a table cell:

- **`processExitTriggersQueueRedelivery` stays `false`.** Under the external runner it looks like it should be `true`: a failed POST _is_ redelivered by the dispatcher, which is the platform-managed shape the flag describes. But eve reacts to `true` by calling `process.exit(1)` when a run exhausts its replay budget, and that process is also serving chat and scheduler traffic for the project. Recycling one run must not drop unrelated in-flight sessions. Keep `false`; failures surface through the event log.
- **`resolveLatestDeploymentId` is worth implementing.** eve calls it when a run is started with `deploymentId: 'latest'`; world-vercel is the only upstream implementation. Ours resolves the project's currently promoted deployment, which is precisely the "new runs follow promote" half of D5 — it turns Phase 3c from a code change into a config question.
- **`hooks.getByToken` is a cross-tenant lookup by construction.** The token is the only input; there is no project in scope. Tokens are opaque and random, so this is safe, but it is the one storage method whose WHERE clause cannot be tenant-scoped by an ambient id — it must instead _read_ the tenant from the row it finds and use that for everything downstream. Call it out in review; it is the most likely place for a tenancy bug.

## 6. Data model

### 6.1 Tenancy column: `tenant_id`, not `project_id`

`workflow_hooks` **already has** a `project_id varchar NOT NULL` column (base migration `0000_cultured_the_anarchist.sql`), and world-postgres writes `''` into it with a `// TODO: get from context` (`dist/storage.js:1151`). It is dead today but it is upstream's column, reserved for upstream's notion of a project. Overloading it with eveland's project id would collide the moment upstream populates it.

So: the platform tenancy column is **`tenant_id`**, carrying the eveland project id, on every platform-owned row. `workflow_hooks.project_id` keeps its (currently empty) upstream meaning and is not read by us. This is a naming decision under D3, not a change to it.

### 6.2 Tables

Ported from world-postgres's `workflow` schema, each gaining `tenant_id`:

| Table                    | Partitioned    | Notes                                                                                        |
| ------------------------ | -------------- | -------------------------------------------------------------------------------------------- |
| `workflow_runs`          | no             | the dispatcher's index: `tenant_id`, `deployment_id`, `status`, `spec_version`, `attributes` |
| `workflow_steps`         | no (candidate) | promote to partitioned if it outgrows `runs` — same LIST-by-tenant recipe                    |
| `workflow_hooks`         | no             | keeps upstream's own `project_id` column alongside `tenant_id`                               |
| `workflow_waits`         | no             | `resume_at` is the sleeping-timer row; the dispatcher never reads it, graphile `run_at` does |
| `workflow_events`        | **LIST**       | append-heavy                                                                                 |
| `workflow_stream_chunks` | **LIST**       | the #213 table — one chunk per token delta                                                   |

Run status enum after upstream migration `0004` is `pending | running | completed | failed | cancelled` — **non-terminal is `pending` and `running`**, which is the predicate the retention guard needs (§11 Phase 3a).

### 6.3 Partitioning constraints (the parts that bite)

- **Every PK and unique index on a partitioned table must contain the partition key.** Concretely: chunks go from `PK (stream_id, id)` to `PK (tenant_id, stream_id, id)`; events go from `PK (id)` to `PK (tenant_id, id)`; and the two unique indexes upstream added later — entity-creation (`0010`) and `attr_set` (`0014`) — must both gain `tenant_id`. Skipping this is not a soft failure; `CREATE TABLE … PARTITION BY` rejects it outright.
- **No `DEFAULT` partition.** Attaching a new partition while a default exists forces Postgres to scan the default for conflicting rows, which turns project creation into an O(fleet) operation at exactly the wrong moment. Without a default, an insert for a project whose partition is missing fails loudly — the correct outcome, since the partition is created during provisioning.
- **Partition lifecycle**: created when the project's world is provisioned, dropped during the deletion drain (§11 Phase 3b). `DROP PARTITION` is the reclaim path that replaces `DROP DATABASE`.
- **Watch the partition count.** One partition per project per partitioned table means 2 × projects. Postgres plans fine into the low thousands with pruning enabled, but planning time grows; if the fleet approaches that, switch to HASH-by-tenant buckets and accept `DELETE` instead of `DROP` for reclaim. Flagged in §15, not solved now.

### 6.4 Indexes the platform adds

Beyond the ported ones:

- `workflow_runs (tenant_id, status)` — fairness and queue-depth metrics.
- `workflow_runs (deployment_id) WHERE status IN ('pending','running')` — the retention guard's only query; partial so it stays small as terminal runs accumulate.
- `workflow_runs (tenant_id, created_at DESC)` — listing surfaces.

graphile's own tables live in the same database in the `graphile_worker` schema, untouched, reached only through the public `add_job` API (§9.3).

## 7. The dispatch contract

Versioned explicitly, because old deployments carry old bundled worlds and must keep working against a newer dispatcher (§9.6).

**Request** — `POST http://127.0.0.1:<endpointPort>/.well-known/workflow/v1/{flow|step}`; route is `flow` when `parseQueueName(queueName).kind === 'workflow'`, else `step`.

| Header                                                | Source       | Notes                                                                                                 |
| ----------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| `x-vqs-queue-name`                                    | eve protocol | verbatim — eve parses these three and 400s if they don't                                              |
| `x-vqs-message-id`                                    | eve protocol | **stable across redeliveries** (§8)                                                                   |
| `x-vqs-message-attempt`                               | eve protocol | graphile attempt number                                                                               |
| `content-type`                                        | eve protocol | `application/json`                                                                                    |
| `authorization`                                       | eveland      | bearer, scheduler pattern ([process-support.ts:27-45](../../apps/worker/src/jobs/process-support.ts)) |
| `x-eveland-runtime-secret`                            | eveland      | same pattern; this is what distinguishes dispatcher traffic from the public path in §4's finding      |
| `x-eveland-dispatch-version`                          | eveland      | `1`; the bundle side rejects a major it doesn't understand                                            |
| `x-eveland-run-id` / `-project-id` / `-deployment-id` | eveland      | diagnostics + an assertion target on the bundle side                                                  |

**Response**

| Response                  | Dispatcher behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `200 {ok: true}`          | job complete                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `200 {timeoutSeconds: N}` | **not complete** — re-enqueue the _same_ `messageId` with `runAt = now + N`. This is eve's delayed-backstop request; world-postgres models it as `{type:'reschedule'}` (`dist/queue.js:239-245`) and re-adds the job with the same `messageId`, same `jobKey`, and `attempt + 1` (`:387-401`). Copy two properties of that implementation: preserving the messageId is what keeps step ownership intact (§8), and the follow-up job is enqueued **before** the handler returns, so a dispatcher crash cannot lose the wake-up. |
| `400`                     | terminal — malformed dispatch or version rejection; never retried, alarms                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `5xx` / network / timeout | throw → graphile retry with backoff, `maxAttempts: 3`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| activation `409`          | terminal for this job — deployment archived or failed; the run needs re-targeting (and should have been protected, §11 Phase 3a)                                                                                                                                                                                                                                                                                                                                                                                               |
| activation `425`          | retry — deployment is draining                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| activation `503` / `504`  | retry — unavailable or cold-start timeout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Activation lease handling** — the part that is easy to get wrong:

The dispatcher acquires a lease before the POST and holds it for the POST's duration. The lease does two jobs at once: it keeps the idle reaper (`EVELAND_ACTIVATION_IDLE_TTL_MS`, 300 000 ms) off the deployment mid-step, and it registers as `active_request` in `getDeploymentRetention`, so a _running_ step already protects its deployment from archival.

But lease TTL is 180 000 ms and a step's duration is unbounded (model calls). **The dispatcher must renew on an interval well inside the TTL for the life of the held POST**, and `DELETE` the lease when the POST returns. A dispatcher that acquires and forgets will have its executor reaped out from under a step that runs longer than three minutes.

Note what this does _not_ cover: a **sleeping** run holds no lease and no connection. That is precisely why the fifth retention reason in §11 Phase 3a is still required — `active_request` protects running steps, `active_workflow_run` protects sleeping ones.

## 8. Delivery and failure semantics

Delivery is **at-least-once**. eve's runtime is replay-based and already idempotent per message; the platform's job is to not break the assumptions that make that true.

**`messageId` must be stable across redeliveries.** This is not a preference — the `Queue` docstring spells out that the runtime's inline step ownership uses `messageId` as a liveness lease: the lazy `step_started` records the handling invocation's id, and only a delivery of that same message may re-execute the step before the lease expires. A world that mints a fresh id per delivery degrades (falls back to the delayed backstop, adding recovery latency) rather than breaking, but there is no reason to accept that. Our job payload carries the messageId, so it is stable by construction — assert it in tests.

| Failure                          | What happens                                                                     | Recovered by                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Agent crashes mid-step           | held POST fails → job fails → backoff retry → activation restarts the deployment | graphile retry                                                                                                          |
| Dispatcher crashes mid-POST      | job stays locked to a dead worker id until its TTL                               | boot recovery: `forceUnlockWorkers(previous ids)` + tenant-scoped re-enqueue (§11 Phase 2c)                             |
| Deployment archived / failed     | activation `409` → job terminal                                                  | should be unreachable once Phase 3a lands; alarms if it happens                                                         |
| Deployment draining              | activation `425` → retry                                                         | graphile retry                                                                                                          |
| Cold start exceeds 30 s          | activation `504` → retry                                                         | graphile retry                                                                                                          |
| Lease expires during a long step | executor reaped mid-step; POST fails                                             | **prevented** by renewal (§7), not recovered                                                                            |
| `maxAttempts` (3) exhausted      | graphile marks the job failed and stops; the run sits non-terminal forever       | **nothing today** — needs an explicit dead-letter path: mark the run, emit a metric, alarm. Do not leave this implicit. |
| Duplicate enqueue                | `jobKey` dedupes at enqueue; replay dedupes at execute                           | by construction                                                                                                         |

**No ordering guarantees**, and none are needed: workflows derive state from the event log, not from message order. Do not add ordering later without re-checking that assumption.

## 9. Non-negotiables

1. **No tenant code in the platform process.** The dispatcher claims, resolves, POSTs — it never imports project bundles.
2. **No prefix/namespace isolation, ever** (PR #67). Tenancy is a schema-level `tenant_id` on every control row; `reenqueueActiveRuns` becomes our code and is tenant-scoped by construction.
3. **graphile containment**: graphile never leaks past the world's queue module. `World` API, vqs protocol, dispatcher surface stay graphile-ignorant. Enqueue only via the public `add_job` SQL API. Never DELETE from graphile's internal tables — project deletion uses tombstone + no-op drain.
4. **Payload minimalism**: job payloads carry ids only (`tenantId`, `deploymentId`, `runId`, `messageId`, attempt); state lives in workflow tables.
5. **Tenant-scoped NOTIFY channels** for the streamer.
6. **Version the dispatch contract explicitly** (§7's `x-eveland-dispatch-version`; do not imitate eve's unvalidated stream-version header). Old deployments' bundled world versions must keep working against a newer dispatcher.
7. **Big tables keep hard-ish isolation**: chunks/events LIST-partitioned by tenant → `DROP PARTITION` reclaim (issue #213 lesson). Control tables are shared with `tenant_id`.

## 10. Configuration surface

New environment variables. **All of them must be registered in `configurationDefinitions` ([config-diagnostics.ts](../../packages/core/src/config-diagnostics.ts)) and documented in [docs/environment-variables.md](../environment-variables.md)** — [env-coverage.test.ts](../../packages/architecture-tests/src/env-coverage.test.ts) and [config-diagnostics-docs.test.ts](../../packages/architecture-tests/src/config-diagnostics-docs.test.ts) fail CI otherwise. This has bitten every recent env-adding PR.

| Variable                                    | Consumer           | Default         | Purpose                                                          |
| ------------------------------------------- | ------------------ | --------------- | ---------------------------------------------------------------- |
| `EVELAND_WORKFLOW_WORLD_URL`                | dispatcher, agents | —               | shared world database (Q1)                                       |
| `EVELAND_WORKFLOW_RUNNER`                   | agents             | `embedded`      | `embedded` \| `external` — the Phase 2 flip and its rollback     |
| `EVELAND_WORKFLOW_DISPATCH_TIMEOUT_MS`      | dispatcher         | generous (Q3)   | held-POST ceiling                                                |
| `EVELAND_WORKFLOW_LEASE_RENEW_INTERVAL_MS`  | dispatcher         | `60000`         | must stay well under `EVELAND_ACTIVATION_LEASE_TTL_MS` (180 000) |
| `EVELAND_WORKFLOW_MAX_INFLIGHT_PER_PROJECT` | dispatcher         | machine-derived | `forbiddenFlags` fairness cap, mirroring `job-concurrency.ts`    |
| `EVELAND_PROJECT_ID`                        | agents             | injected        | reserved env; tenancy                                            |
| `EVELAND_DEPLOYMENT_ID`                     | agents             | injected        | reserved env; affinity, and `getDeploymentId()`'s return value   |

Existing and unchanged: `EVELAND_ACTIVATION_LEASE_TTL_MS`, `EVELAND_COLD_START_TIMEOUT_MS`, `EVELAND_ACTIVATION_IDLE_TTL_MS`. Retired at the end of run-out: `WORKFLOW_POSTGRES_URL`, `WORKFLOW_POSTGRES_MAX_POOL_SIZE`.

## 11. Incremental delivery plan

Each phase is independently shippable, gated, and rollbackable. Suggested PR granularity matches house style (single-purpose PRs like #258/#259/#261).

### Phase 0 — De-risk (no behavior change)

- **0a** Empirically confirm the timer gap: test project, `sleep 10min` workflow, let the idle reaper kill the agent, observe the stall. Record in an issue — this is the acceptance baseline.
- **0b** ~~Executor endpoint recon~~ — **done, see §4.** The vqs endpoint is publicly reachable and unauthenticated. What remains is the fix, filed as its own issue: reject unauthenticated `/.well-known/workflow/v1/*` at the gateway (it has no legitimate public caller), keeping loopback and dispatcher access intact. Must land before Phase 2.
- **0c** Claim the npm `@eveland` org; scaffold `@eveland/workflow-world@0.0.x`.
- **0d** Metrics: per-project `oldest_due_job_age` scanned from existing `eveland_wf_*` DBs → OTLP → health page. (Quantifies 0a in prod; later becomes the Phase 4 drain monitor.)

### Phase 1 — The world package, embedded-runner mode (no dispatcher yet)

Ship the multi-tenant world while keeping today's execution topology, so schema/tenancy/eve-compat are validated with a rollback that is just a flag flip.

- **1a** Shared DB + schema (own migrations, `bin/setup` like world-postgres): §6's tables, `tenant_id` everywhere, LIST-partitioned chunks/events with the §6.3 constraints. Decide DB identity (Q1).
- **1b** Port storage (drizzle→drizzle, add tenant predicate — mind `hooks.getByToken`, §5), streamer (tenant-scoped channels), graphile queue mapping (flags `project:<id>`; keep `jobKey`/`maxAttempts`/backoff semantics).
- **1c** `EVELAND_WORKFLOW_RUNNER: embedded | external` config. v1 default `embedded` — in-process runner, loopback executor, behavior parity with world-postgres. (Embedded mode is a keeper: it is the local-dev story forever.)
- **1d** Worker-side: per-project flag choosing the injected world; inject `EVELAND_PROJECT_ID`/`EVELAND_DEPLOYMENT_ID` (reserved env); runs record a real `deploymentId`; implement `resolveLatestDeploymentId`.
- **1e** Contract tests (§12).
- **Gate**: one test project runs chat + a durable workflow end-to-end on the new world. **Rollback**: flag back → next build uses world-postgres.

### Phase 2 — Dispatcher app (external runner) — the headline milestone

- **2a** New resident app: graphile runner on the shared DB; handler = affinity resolution (`run.deploymentId` → activation → `runtimeInstance.endpointPort`) → sync-held vqs POST.
- **2b** vqs auth + the §7 header set, including lease acquisition, **renewal**, and release around the held POST.
- **2c** Boot recovery: `forceUnlockWorkers(previous-generation ids)` + tenant-scoped re-enqueue.
- **2d** Fairness: `forbiddenFlags` callback enforcing per-project in-flight caps (machine-derived default, env override).
- **2e** Dead-letter path for `maxAttempts`-exhausted jobs (§8) — metric + alarm + a non-silent run state.
- **2f** Flip the test project to `runner: external`; systemd unit + docker-compose entry; heartbeat/health integration.
- **Gate**: `sleep 10min` workflow → idle reaper kills the agent → dispatcher wakes the deployment via activation API → workflow resumes on time. **Rollback**: per-project `runner: embedded`.

### Phase 3 — Lifecycle guards

- **3a** Retention: fifth protected reason `active_workflow_run` in `getDeploymentRetention` — runs in `('pending','running')` grouped by `deployment_id` (§6.4's partial index). Covers sleeping runs; `active_request` already covers running steps via the held lease (§7).
- **3b** Project deletion: tombstone → dispatcher no-ops that project's jobs → drain → `DROP PARTITION`.
- **3c** New-run routing on promote — largely covered by `resolveLatestDeploymentId` from 1d; verify eve actually consults it for the paths eveland uses.
- **3d** Observability: queue depth/project, in-flight held-POST count, throttled-project set, jobs-table bloat, dead-letter count.
- **Gate**: archive job provably refuses a deployment holding a sleeping run.

### Phase 4 — Fleet rollout + legacy run-out

- **4a** Flag default flips: all _new_ deployments build with `@eveland/workflow-world` (external runner).
- **4b** Drain monitor (0d) watches legacy `eveland_wf_*` DBs; zero active runs → drop via the existing `dropProjectWorkflowWorld` path; legacy chunk reaper retires with the last DB.
- **4c** Update docs/deploy/linux.md connection sizing (per-agent pool math changes) and remove the world-postgres pin.
- **Gate**: zero `eveland_wf_*` databases remain.

## 12. Test strategy

The compatibility surface is a moving beta target (§15), so the tests that matter most are the ones that fail loudly on an eve bump rather than in production.

- **eve-compat contract tests** (source-contract style, Phase 1e): assert against the _installed_ eve and `@workflow/world` that (a) our `specVersion` still equals the literal eve enforces, (b) our package manifest still satisfies `assertWorkflowWorldCompatibility`'s major+tag rule, (c) our world still passes `isWorkflowWorld`'s duck-type check, (d) the three `x-vqs-*` header names and the `/.well-known/workflow/v1/{flow,step}` paths are unchanged. These belong next to the existing [eve-compatibility-consistency.test.ts](../../packages/architecture-tests/src/eve-compatibility-consistency.test.ts).
- **Type-level conformance**: our world assigned to `World` from the pinned `@workflow/world` — a compile error is the cheapest possible signal that upstream changed the interface.
- **Schema tests**: partition-key coverage on every PK and unique index of a partitioned table; no `DEFAULT` partition exists; tenant predicate present on every storage query (a query-builder-level assertion beats a reviewer's eye).
- **Tenancy tests**: two tenants, interleaved runs; every storage method returns only its own rows; `hooks.getByToken` resolves the tenant from the row rather than from ambient state.
- **Dispatcher integration**: a fake agent HTTP server asserting the §7 request contract and driving each §8 row — including the `{timeoutSeconds}` reschedule preserving `messageId`, lease renewal firing on a long step, and the dead-letter path after three failures.
- **The acceptance test is 0a's baseline, re-run**: `sleep 10min` survives the idle reaper. That single test is the reason this project exists; it belongs in CI as an integration test, not just as a manual gate.

Note the house gotcha: source-contract tests break on reformat, so keep asserted snippets narrow.

## 13. Open questions (decide during implementation; recommendations attached)

- **Q1** Shared DB identity: reuse the existing base `WORKFLOW_POSTGRES_URL` database (which worker boot already bootstraps with world-postgres schema — investigate what, if anything, uses it) or a fresh dedicated DB. _Lean: fresh dedicated DB, avoid mixed schemas._
- **Q2** Flag shape: project-level column governing next build vs deployment-level record of what was baked. _Lean: both — project column as the knob, deployment row records the baked world for dispatch-time decisions._
- **Q3** Sync-hold POST timeout policy (step duration is unbounded — model calls). _Lean: generous timeout plus the §7 lease renewal, which is the part that actually keeps the executor alive; async-ack redesign only when in-flight counts hurt._
- **Q4** Whether the dispatcher also absorbs scheduler triggering later (cron → run creation) to unify the promote/target logic. _Out of scope now; revisit after Phase 4._
- **Q5** RLS + `SET ROLE` hardening timing. _Lean: not before open-sourcing._
- **Q6** Dead-letter representation for `maxAttempts`-exhausted jobs (§8): a `run_failed` event, or a platform-side table that keeps the run resumable by an operator? _Lean: platform-side, because a failed run that could have succeeded is an operator problem, not a workflow outcome._

_Resolved since the first draft:_ eve's enforcement of `specVersion` and world version lines (§4); whether the vqs endpoint is publicly reachable (§4 — it is, and unauthenticated); how the dispatcher learns a deployment's port (§4 — from the activation response).

## 14. Explicitly out of scope (future)

Async-ack dispatch; HTTP storage (agents reach zero PG connections — the true tenant boundary and the full "single pool" payoff); declarative platform workflows layered on the dispatch primitive; multi-machine dispatcher replicas (`SKIP LOCKED` claim design is already replica-safe — keep it that way, no in-memory claim state); at-rest payload encryption via `getEncryptionKeyForRun`.

## 15. Known risks / watch items

- `@workflow/*` is all `5.0.0-beta.*` and churns; eve is tracked at latest (house policy). Every eve bump: re-run the §12 contract tests — especially the `specVersion` literal, which is compiled into eve per release.
- The unauthenticated public vqs endpoint (§4) exists **today**, independent of this work. It must be closed before Phase 2 makes the platform a legitimate caller of the same path.
- Streamer's out-of-pool LISTEN client is likely unaccounted in the #259 connection budget (+1/agent) — separate task already flagged.
- graphile jobs table on the shared DB is a hot table with delete-on-complete churn — watch autovacuum/bloat (3d metric).
- Partition count grows at 2× projects (§6.3); has a ceiling, with a documented escape hatch.
- Single dispatcher is a restart-pause SPOF: keep it stateless (all claim state in PG) so a restart is a brief pause + boot recovery, never data loss.
- Payloads remain unencrypted at rest on a now-shared database. Acceptable under D9's threat model for a single-operator platform; revisit alongside RLS (Q5).
