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

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Orchestration centralizes; **execution stays in deployments**. The platform never loads tenant bundles.                                                                                                                                                                                                                                                                                                              |
| D2  | New package **`@eveland/workflow-world`** (public npm, `0.x`, experimental banner) implements eve's `World` interface (`Queue & Storage & Streamer` from `@workflow/world`). Injected at build time exactly like world-postgres today ([workflow-world.ts:5](../../apps/worker/src/runtime/workflow-world.ts) `PLATFORM_WORKFLOW_WORLD` flips once).                                                                 |
| D3  | **Natively multi-tenant**: one shared Postgres database for all projects. No more per-project `eveland_wf_*` databases (legacy ones drain via run-out, §6 Phase 4).                                                                                                                                                                                                                                                  |
| D4  | **graphile-worker 0.16.6 stays** as the queue substrate, now a first-party pinned dependency. Verified in the installed package: `forbiddenFlags` accepts a per-claim function (`dist/worker.js:95-103`), `addJob` takes `flags text[]` (`dist/helpers.js:20`), `workerUtils.forceUnlockWorkers(workerIds)` exists.                                                                                                  |
| D5  | **Run affinity**: new runs target the currently promoted deployment; in-flight runs are pinned to the deployment that created them. Runs must record a **real** `deploymentId` (world-postgres hardcodes `getDeploymentId() → 'postgres'`).                                                                                                                                                                          |
| D6  | **Dispatcher is a separate resident app** (new `apps/` entry + systemd unit), not a worker module. Activation goes through the existing internal API (`POST /internal/runtime/activations`, [app-internal-routes.ts](../../apps/api/src/app-internal-routes.ts); gateway is the precedent client via [activation-client.ts](../../apps/gateway/src/activation-client.ts)) — never by reaching into worker internals. |
| D7  | **Data flow**: agents and the dispatcher never message each other directly — they rendezvous in shared Postgres. The only direct connection is dispatcher→agent: one held vqs POST per in-flight step (sync-hold v1; async-ack 202+callback is a later evolution). POST return = job complete. Zero standing connections when idle.                                                                                  |
| D8  | **Migration = run-out, no data migration.** World choice is a build-time property of the deployment, so old (world-postgres) and new deployments coexist by construction. A per-project flag governs the _next_ build; rollback = rebuild with the flag off.                                                                                                                                                         |
| D9  | Tenant boundary v1 is WHERE-clause discipline (accident-level, acceptable for the single-operator platform). Threat model documented; RLS + `SET ROLE` optional hardening; the real boundary is future HTTP storage (§8).                                                                                                                                                                                            |

## 3. Target architecture — the life of one step

```mermaid
sequenceDiagram
    participant A as agent deployment<br/>(eve executor + @eveland/workflow-world)
    participant PG as shared Postgres<br/>(control tables + partitions + graphile)
    participant D as workflow dispatcher<br/>(resident app)
    A->>PG: world.queue.send → add_job(flags=[project:X], payload={ids}, run_at)
    D->>PG: graphile claim (LISTEN/NOTIFY + 500ms, forbiddenFlags skips capped projects)
    D->>D: affinity: run.deploymentId → hostPort;<br/>inactive → POST /internal/runtime/activations
    D->>A: vqs POST (x-vqs-* headers, held for step duration)
    A->>PG: executor runs step; storage/events/stream chunks written directly
    A-->>D: POST returns → job complete (fail → maxAttempts 3 + backoff)
```

**One sentence**: PG is the rendezvous, the dispatcher is the only active party, agents only receive POSTs and write to the DB.

Two ids, two roles: `projectId` = tenancy (data scoping, fairness flags, deletion drain); `deploymentId` = affinity (in-flight runs pin their executor; new runs follow promote).

## 4. Verified facts — do not re-explore these

Package internals were read from the parent checkout's `node_modules` (pnpm store); eveland refs are repo paths.

**world-postgres `5.0.0-beta.25`** (the thing being replaced; also the porting source):

- Composition: `createClient(pool)` + `createQueue(config, pool)` + `createStorage(drizzle)` + `createStreamer(pool, drizzle)` — `dist/index.js:31-39`; startup `queue.start(); reenqueueActiveRuns(storage.runs, queue.queue, 'world-postgres', config.namespace)` at `:48-51` (namespace is unset in eveland — physical DB separation is the _sole_ isolation today; **PR #67's root cause lives here**).
- Queue/exec split already exists: the graphile task handler POSTs vqs messages over HTTP to the local eve executor (`executeMessageOverHttp`, `dist/queue.js:207-230`; headers `x-vqs-queue-name` / `x-vqs-message-id` / `x-vqs-message-attempt`; route `flow`|`step`; base URL from `WORKFLOW_LOCAL_BASE_URL` → `config.port` → `PORT`, `:118-136`). Runner: `run({concurrency: 50, pollInterval: 500})` `:449-471`. `createQueueHandler` (executor side) is delegated to `@workflow/world-local` `:76` — that side is eve's, we keep it.
- Idempotent enqueue: `jobKey = idempotencyKey ?? messageId`, `maxAttempts: 3` (`dist/queue.js:97-115, 351`).
- Streamer: dedicated out-of-pool `new Client(pool.options)` LISTENing on channel `workflow_event_chunk`, publish via `pg_notify` (`dist/streamer.js:38-62, 80-103`). **In a shared DB this channel becomes a global broadcast — channel names must be tenant-scoped (e.g. suffix projectId).**
- Version skew already live: eve 0.29.x bundles `@workflow/world@5.0.0-beta.23`; world-postgres pins `beta.19`. eve calls `validateWorkflowWorld` at compile time — enforcement unverified (check during Phase 1).

**eveland wiring**:

- Build-time injection: [prepare-release.ts:29](../../apps/worker/src/runtime/prepare-release.ts) → `injectWorkflowWorld` ([workflow-world.ts:36-114](../../apps/worker/src/runtime/workflow-world.ts)) rewrites agent config (`experimental.workflow.world`), installs the package in [docker.ts:225](../../apps/worker/src/runtime/docker.ts) / [systemd.ts:187](../../apps/worker/src/runtime/systemd.ts).
- Env injection + reserved keys: [process-support.ts:248-262](../../apps/worker/src/jobs/process-support.ts), [reserved-environment.ts:21-34](../../apps/worker/src/runtime/reserved-environment.ts) (`WORKFLOW_POSTGRES_URL`, `WORKFLOW_POSTGRES_MAX_POOL_SIZE`; add `EVELAND_PROJECT_ID`, `EVELAND_DEPLOYMENT_ID`).
- Per-project DB provisioning/teardown (legacy path, stays during run-out): [workflow-world-bootstrap.ts](../../apps/worker/src/runtime/workflow-world-bootstrap.ts) (`eveland_wf_<safe>_<sha6>`, `drop database … with (force)` from [delete-project.ts:69](../../apps/worker/src/jobs/runtime-jobs/delete-project.ts)); chunk retention sweeper [workflow-world-reaper.ts](../../apps/worker/src/runtime/workflow-world-reaper.ts) enumerates DBs by prefix.
- **The scheduler blueprint** (mirror this shape for dispatch): planner tick → `claimDueScheduleRuns` (`FOR UPDATE SKIP LOCKED`, [postgres-schedule-store.ts:325](../../packages/db/src/postgres-schedule-store.ts)) → [trigger-schedule.ts](../../apps/worker/src/jobs/runtime-jobs/trigger-schedule.ts) validates, `ensureDeploymentActive`, then POST `http://127.0.0.1:<hostPort>/eveland/scheduler/:id` with `authorization` + `x-eveland-runtime-secret` ([process-support.ts:27-45](../../apps/worker/src/jobs/process-support.ts)); channel injected at build time by [agent-scheduler/adapter.ts](../../packages/agent-scheduler/src/adapter.ts).
- Fairness precedent: machine-derived global cap [job-concurrency.ts:17-22](../../apps/worker/src/runtime/job-concurrency.ts) (`min(mem/4GiB, cores-2)`, `EVELAND_MAX_CONCURRENT_JOBS` override) — reuse the idea inside the `forbiddenFlags` callback.
- Reachability: deployments are loopback TCP on allocated host ports (base `EVELAND_DEPLOYMENT_PORT` 41000, [ports.ts](../../apps/worker/src/runtime/ports.ts)); ports persisted on deployment + runtime_instances rows.

## 5. Non-negotiables

1. **No tenant code in the platform process.** The dispatcher claims, resolves, POSTs — it never imports project bundles.
2. **No prefix/namespace isolation, ever** (PR #67). Tenancy is a schema-level `project_id` on every control row; `reenqueueActiveRuns` becomes our code and is tenant-scoped by construction.
3. **graphile containment**: graphile never leaks past the world's queue module. `World` API, vqs protocol, dispatcher surface stay graphile-ignorant. Enqueue only via the public `add_job` SQL API. Never DELETE from graphile's internal tables — project deletion uses tombstone + no-op drain.
4. **Payload minimalism**: job payloads carry ids only (`projectId`, `deploymentId`, `runId`, `messageId`, attempt); state lives in workflow tables.
5. **Tenant-scoped NOTIFY channels** for the streamer.
6. **Version the dispatch contract explicitly** (a header the dispatcher sends and the bundle-side checks; do not imitate eve's unvalidated stream-version header). Old deployments' bundled world versions must keep working against a newer dispatcher.
7. **Big tables keep hard-ish isolation**: chunks/events LIST-partitioned by project → `DROP PARTITION` reclaim (issue #213 lesson). Control tables (runs index, claims, queue) are shared with `project_id`.

## 6. Incremental delivery plan

Each phase is independently shippable, gated, and rollbackable. Suggested PR granularity matches house style (single-purpose PRs like #258/#259/#261).

### Phase 0 — De-risk (no behavior change)

- **0a** Empirically confirm the timer gap: test project, `sleep 10min` workflow, let the idle reaper kill the agent, observe the stall. Record in an issue — this is the acceptance baseline.
- **0b** Executor endpoint recon: find eve's vqs handler route + auth on a running deployment; test whether it is reachable through the gateway's public hostname routing. **If publicly reachable, fix that first — it's an injection surface today, independent of this project.**
- **0c** Claim the npm `@eveland` org; scaffold `@eveland/workflow-world@0.0.x`.
- **0d** Metrics: per-project `oldest_due_job_age` scanned from existing `eveland_wf_*` DBs → OTLP → health page. (Quantifies 0a in prod; later becomes the Phase 4 drain monitor.)

### Phase 1 — The world package, embedded-runner mode (no dispatcher yet)

Ship the multi-tenant world while keeping today's execution topology, so schema/tenancy/eve-compat are validated with a rollback that is just a flag flip.

- **1a** Shared DB + schema (own migrations, `bin/setup` like world-postgres): control tables with `project_id`+`deployment_id`, LIST-partitioned chunks/events. Decide DB identity (see Q1, §7).
- **1b** Port storage (drizzle→drizzle, add tenant column), streamer (tenant-scoped channels), graphile queue mapping (flags `project:<id>`; keep `jobKey`/`maxAttempts`/backoff semantics).
- **1c** `runner: embedded | external` config. v1 default `embedded` — in-process runner, loopback executor, behavior parity with world-postgres. (Embedded mode is a keeper: it is the local-dev story forever.)
- **1d** Worker-side: per-project flag choosing the injected world; inject `EVELAND_PROJECT_ID`/`EVELAND_DEPLOYMENT_ID` (reserved env); runs record real `deploymentId`.
- **1e** Contract tests (source-contract style): `World` interface shape vs `@workflow/world` types; our SQL schema; check what `validateWorkflowWorld`/`specVersion` actually enforce.
- **Gate**: one test project runs chat + a durable workflow end-to-end on the new world. **Rollback**: flag back → next build uses world-postgres.

### Phase 2 — Dispatcher app (external runner) — the headline milestone

- **2a** New resident app: graphile runner on the shared DB; handler = affinity resolution (`deploymentId` → deployment row → hostPort, status checks) → activation via internal API when inactive → sync-held vqs POST.
- **2b** vqs auth: mirror the scheduler's header pattern (`x-eveland-runtime-secret` + bearer), plus the explicit dispatch-contract version header (§5.6).
- **2c** Boot recovery: `forceUnlockWorkers(previous-generation ids)` + tenant-scoped `reenqueueActiveRuns`.
- **2d** Fairness: `forbiddenFlags` callback enforcing per-project in-flight caps (machine-derived default, env override).
- **2e** Flip the test project's world to `runner: external`; systemd unit + docker-compose entry; heartbeat/health integration.
- **Gate**: `sleep 10min` workflow → idle reaper kills the agent → dispatcher wakes the deployment via activation API → workflow resumes on time. **Rollback**: per-project `runner: embedded`.

### Phase 3 — Lifecycle guards

- **3a** Retention: fifth protected reason `active_workflow_run` in `getDeploymentRetention` (query the new world's runs by deployment).
- **3b** Project deletion: tombstone → dispatcher no-ops that project's jobs → drain → `DROP PARTITION`.
- **3c** New-run routing on promote (verify whether eve consults `resolveLatestDeploymentId`).
- **3d** Observability: queue depth/project, in-flight held-POST count, throttled-project set, jobs-table bloat.
- **Gate**: archive job provably refuses a deployment holding a sleeping run.

### Phase 4 — Fleet rollout + legacy run-out

- **4a** Flag default flips: all _new_ deployments build with `@eveland/workflow-world` (external runner).
- **4b** Drain monitor (0d) watches legacy `eveland_wf_*` DBs; zero active runs → drop via the existing `dropProjectWorkflowWorld` path; legacy chunk reaper retires with the last DB.
- **4c** Update docs/deploy/linux.md connection sizing (per-agent pool math changes) and remove the world-postgres pin.
- **Gate**: zero `eveland_wf_*` databases remain.

## 7. Open questions (decide during implementation; recommendations attached)

- **Q1** Shared DB identity: reuse the existing base `WORKFLOW_POSTGRES_URL` database (which worker boot already bootstraps with world-postgres schema — investigate what, if anything, uses it) or a fresh dedicated DB. _Lean: fresh dedicated DB, avoid mixed schemas._
- **Q2** Flag shape: project-level column governing next build vs deployment-level record of what was baked. _Lean: both — project column as the knob, deployment row records the baked world for dispatch-time decisions._
- **Q3** Sync-hold POST timeout policy (step duration is unbounded — model calls). _Lean: generous timeout + heartbeat check on the deployment; async-ack redesign only when in-flight counts hurt._
- **Q4** Whether the dispatcher also absorbs scheduler triggering later (cron → run creation) to unify the promote/target logic. _Out of scope now; revisit after Phase 4._
- **Q5** RLS + `SET ROLE` hardening timing. _Lean: not before open-sourcing._

## 8. Explicitly out of scope (future)

Async-ack dispatch; HTTP storage (agents reach zero PG connections — the true tenant boundary and the full "single pool" payoff); declarative platform workflows layered on the dispatch primitive; multi-machine dispatcher replicas (`SKIP LOCKED` claim design is already replica-safe — keep it that way, no in-memory claim state).

## 9. Known risks / watch items

- `@workflow/*` is all `5.0.0-beta.*` and churns; eve is tracked at latest (house policy). Every eve bump: re-check `World` interface, `specVersion`, vqs headers via the Phase 1e contract tests.
- Streamer's out-of-pool LISTEN client is likely unaccounted in the #259 connection budget (+1/agent) — separate task already flagged.
- graphile jobs table on the shared DB is a hot table with delete-on-complete churn — watch autovacuum/bloat (3d metric).
- Single dispatcher is a restart-pause SPOF: keep it stateless (all claim state in PG) so a restart is a brief pause + boot recovery, never data loss.
