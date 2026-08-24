# Workflow Dispatcher Namespaced Boot-Recovery Handoff

- **Date:** 2026-08-09
- **Status:** upstream fixed in `@evelandhq/workflow-world 0.4.0`; Eveland consumption implemented, full platform wake E2E pending
- **Eveland baseline:** `daf215ea` (`main`, product `0.29.0`)
- **Upstream fix:** `workflow-world-v0.4.0` (`179272594c862d3c916f8c59f600c3ab4b7c2f63`)
- **Primary scope:** preserve Eve's queue namespace when the external dispatcher reconstructs jobs for active runs during boot recovery

## Outcome required

A workflow enqueued by a namespaced Eve deployment must survive an external
dispatcher restart. Boot recovery must deliver the reconstructed message to the
same queue topic the deployment registered, without a `400 Unhandled queue`,
without using the dispatcher's environment as the namespace authority, and
without weakening tenant or Deployment affinity.

The implementation owner is the separate
[`evelandhq/workflow-world`](https://github.com/evelandhq/workflow-world)
package. Eveland consumes the published package and injects it into immutable
Releases. Do not patch `node_modules` in this repository.

## Eveland consumption update

The follow-up session consumed the published fix in this worktree:

- both `apps/worker` and `apps/workflow-dispatcher` now depend on `^0.4.0`;
- immutable Release injection is pinned to exactly `0.4.0`;
- the lockfile resolves both consumers to the same `0.4.0` package;
- the existing architecture contract verifies that the installed and injected
  versions match and remain compatible with every supported Eve line;
- the wake fixture now starts Eve's registered `turnWorkflow` with a
  deterministic model and Eve's official durable `sleep` tool;
- the wake harness deletes the original delayed Graphile job, starts a second
  production dispatcher service to trigger boot recovery, requires the real
  turn workflow to complete a post-sleep `turnStep`, and rejects every dead
  letter.

Observed verification:

1. The existing Eve-to-world compatibility contract passed with the installed
   and injected package at `0.4.0`.
2. A materialized Eve `0.31.3` fixture built successfully and its local
   `/start-wake` route returned a real session id when driven with a two-second
   durable sleep.

## Startup ordering follow-up

A later manual restart proved the namespace fix separately from the startup
race: recovered jobs initially logged `fetch failed`, then completed successfully
on attempt 2 after the API began listening. Eveland now probes the configured API
`/health` endpoint before starting the dispatcher service, so boot recovery cannot
claim jobs during that gap. The launcher retries connection failures and unhealthy
responses without consuming a Graphile attempt; the package still owns normal
dispatch retries after the health gate opens.

The full scale-to-zero platform E2E still needs an isolated stack running this
worktree. The already-running native stack belongs to the separate
`<eveland-checkout>` checkout and still runs its older worker and
dispatcher, so it was not mutated as a substitute for that verification.
Run the upgraded harness there with:

```bash
pnpm --filter @evelandhq/worker smoke:workflow-wake
```

## Repositories and local state

- Eveland Codex worktree: `<eveland-worktree>`
- Eveland runtime checkout used to reproduce: `<eveland-checkout>`
- Workflow-world upstream checkout: `<workflow-world-checkout>`
- Both checkouts were clean when inspected.
- The native development stack was still running after cleanup. API, Web,
  Docs, and Gateway listened on ports `4000`, `3000`, `3001`, and `4080`.

Read `AGENTS.md`, `docs/spec.md`, and `README.md` before changing Eveland. In
the upstream checkout, read its own repository instructions before editing.
Follow test-first development in both repositories.

## User-visible symptom

Running `pnpm dev` printed many copies of:

```text
apps/workflow-dispatcher dev: ERROR: Failed task ...
Dispatch threw: TypeError: fetch failed
```

There were twelve copies because the shared workflow database contained twelve
active runs for one Project. They were not twelve independent startup defects.

The first failure and the durable failure were different:

1. Root `package.json` runs every workspace with `pnpm -r --parallel dev`.
   The dispatcher began claiming jobs before the API listened on port `4000`,
   so its first activation requests failed at `fetch()`.
2. Graphile retried after the API became ready. Activation then succeeded, but
   the Agent rejected every recovered VQS delivery with HTTP 400
   `{"error":"Unhandled queue"}`.
3. The dispatcher correctly treated that 400 as terminal and inserted dead
   letters. The active run rows remained `running`, so the next dispatcher
   start reconstructed them again and repeated the cycle.

The API startup race explains the initial `fetch failed` text, but it is not
the workflow correctness defect in this handoff. Readiness gating or clearer
network error logging may be handled separately.

The Graphile message about a missing `apps/workflow-dispatcher/crontab` was
informational: cron was disabled and the dispatcher continued normally.

## Confirmed root cause

Eve registers workflow queue handlers under a namespace. In the observed
Deployment the durable message contained:

```text
queueNamespace = eve68656c6c6f2d657665
```

That suffix decodes to the fixture package name `hello-eve`, but the fix must
not guess or reimplement Eve's namespace algorithm.

The executor therefore owned a topic shaped like:

```text
__eve68656c6c6f2d657665_wkf_workflow_<workflow-name>
```

Normal external-mode enqueue is correct:

- `src/queue.ts` resolves the namespace in the deployment process;
- it strips the prefix from `MessageData.id`;
- it persists the resolved namespace on `MessageData.queueNamespace`;
- `src/dispatcher/runner.ts` reconstructs the full queue name from the message,
  never from the host dispatcher's environment.

External boot recovery bypasses that enqueue context. In
`src/dispatcher/boot-recovery.ts`,
`reenqueueActiveRunsForAllTenants()` currently selects only:

```sql
select tenant_id, id, name, deployment_id
from workflow.workflow_runs
where status in ('pending', 'running')
```

It then constructs a synthetic `MessageData` without `queueNamespace`.
`src/dispatcher/runner.ts` consequently rebuilds the default topic:

```text
__wkf_workflow_<workflow-name>
```

That topic is not owned by the namespaced executor, so Eve correctly answers
`400 Unhandled queue`.

`src/message.ts` currently claims that an absent namespace means the default
prefix "which is what every deployment gets today." The observed Eve 0.31.0
Deployment disproves that assumption: its container had no
`WORKFLOW_QUEUE_NAMESPACE` environment variable, yet Eve configured the world
with the non-empty namespace above.

The deployment-side `reenqueueTenantRuns()` path in `src/recovery.ts` is not the
same bug. It calls the deployment's configured `queue.queue`, whose closure
still knows the resolved namespace and records it on the new message. The
external dispatcher boot path manually creates the message and has no such
context.

## Version evidence and an important non-fix

At reproduction time:

- the current Eveland dispatcher used `@evelandhq/workflow-world 0.3.0` with
  `@workflow/world 5.0.0-beta.25`;
- the pinned immutable Deployment `dep_y6iQAlM6Qi` / Release
  `rel_cEmgTYOy2T` used `@evelandhq/workflow-world 0.2.0`,
  `@workflow/world 5.0.0-beta.24`, and Eve `0.31.0`.

That version skew is real and should remain visible in compatibility tests, but
it is not a sufficient root-cause explanation. The installed 0.2.0 and 0.3.0
copies had the same dispatcher boot-recovery and message code. Merely rebuilding
the Agent, pinning the dispatcher back to 0.2.0, or bumping both ends to 0.3.0
does not make boot recovery retain the namespace.

## Database evidence before cleanup

Shared database: `eveland_workflow`.

Affected owner:

```text
tenant_id      proj_313NE8qeO9
deployment_id  dep_y6iQAlM6Qi
release_id     rel_cEmgTYOy2T
project slug   sample-hello-world-gitlab-v030
```

Observed state:

- 12 `workflow.workflow_runs` rows with `status = running`, created on
  2026-08-07;
- 20 Graphile jobs for the tenant, including exhausted historical jobs and
  delayed timeout jobs;
- 44 tenant dead letters;
- all 44 tenant dead letters had reason
  `Executor rejected the dispatch with HTTP 400: {"error":"Unhandled queue"}`;
- the twelve boot-recovery dead-letter payloads had a missing
  `queueNamespace`;
- ordinary later messages in the same database carried
  `eve68656c6c6f2d657665`, proving that the normal enqueue path retained it.

The database schema has no `queue_namespace` column on
`workflow.workflow_runs`, so the dispatcher cannot recover the value from the
run row after the original Graphile message is gone.

## Cleanup already performed

Do not repeat cleanup as part of reproduction. A backup was created first:

```text
<eveland-checkout>/.eveland-data/backups/
  eveland_workflow-before-cleanup-20260809-1706.dump
SHA-256:
a072995400f5e3b673f642d6ebd661eef2c5a567df9fc4cb3bae30a6255891cc
```

Only the affected tenant was changed:

- 12 active runs changed from `running` to `cancelled` with terminal
  timestamps;
- 6 waits belonging to those runs were deleted;
- 20 Graphile jobs belonging to the tenant were deleted;
- 44 dead letters belonging to the tenant were deleted.

Preserved:

- 16 completed runs for the tenant;
- 2 runs that were already cancelled;
- Eveland's main `eveland` database;
- all other Projects and Deployments;
- 3 dead letters belonging to another test tenant.

Post-cleanup verification:

```text
affected tenant: completed=16, cancelled=14
active runs:      0
tenant jobs:      0
tenant deadletters: 0
```

This suppresses the current repeated startup noise. It does not repair the
recovery implementation; a future namespaced workflow left active across a
dispatcher restart can reproduce the defect.

## Relevant upstream files

In `<workflow-world-checkout>`:

- `src/dispatcher/boot-recovery.ts` — loses the namespace while reconstructing
  `MessageData`;
- `src/dispatcher/runner.ts` — correctly rebuilds the topic from
  `message.queueNamespace`;
- `src/message.ts` — wire shape and the now-invalid absent-means-default
  comment;
- `src/queue.ts` — correct normal enqueue behavior;
- `src/index.ts` — resolves the deployment namespace but currently passes only
  `tenantId` into storage creation;
- `src/drizzle/schema.ts` — `workflow_runs` lacks durable namespace metadata;
- `src/storage.ts` — both resilient-start and `run_created` insertion paths
  create run rows;
- `migrations/` — shipped migrations; add a new migration rather than editing
  an existing one;
- `src/queue-namespace.test.ts` — proves normal message round-trip only;
- `src/dispatcher/dispatch-loop.integration.test.ts` — real Eve handler, but
  currently tests only the un-namespaced live enqueue path;
- `src/recovery.test.ts` — deployment-local recovery coverage;
- `src/dispatcher/service.ts` — starts the runner before invoking global boot
  recovery.

## Relevant Eveland files

In this repository:

- `apps/workflow-dispatcher/src/main.ts` — intentionally thin wrapper; do not
  duplicate upstream dispatcher behavior here;
- `apps/workflow-dispatcher/package.json` and `apps/worker/package.json` — must
  consume the same published world version;
- `apps/worker/src/runtime/workflow-world.ts` — immutable Release injection
  constant; must exactly match the installed package;
- `packages/architecture-tests/src/eve-workflow-world-contract.test.ts` —
  enforces injection/version and Eve workflow-contract compatibility;
- `apps/worker/src/integration/workflow-wake-e2e.ts` — starts Eve's registered
  turn workflow, removes its original delayed job, triggers production boot
  recovery, and requires post-sleep body resumption with zero dead letters;
- `docs/environment-variables.md` documents dispatcher ownership and runtime
  variables.

## Recommended test-first sequence

Start in `<workflow-world-checkout>`.

### 1. Add a narrow failing persistence/recovery test

Use a scratch real Postgres database and a world configured with:

```ts
{
  tenantId: "prj_recovery_namespace",
  deploymentId: "dep_recovery_namespace",
  runner: "external",
  queueNamespace: "acme",
}
```

Create an active run through the real storage/event path, remove or consume its
original Graphile job, call `reenqueueActiveRunsForAllTenants()`, parse the
newest recovery payload with `MessageData`, and require:

```ts
expect(message.queueNamespace).toBe("acme");
```

Observe this fail before implementation. Do not seed a run row with a test-only
column value in a way that bypasses the production write path.

### 2. Add a real handler restart test

Extend the real dispatch-loop integration coverage:

1. register an Eve handler at `__acme_wkf_workflow_greet`;
2. persist an active namespaced run;
3. simulate loss of the original job / dispatcher restart;
4. run global boot recovery;
5. allow the real dispatcher to claim the recovered job;
6. assert the real Eve handler returns 200 and receives
   `__acme_wkf_workflow_greet`;
7. assert no `workflow.dispatch_dead_letters` row was created.

The existing fake-agent unit tests are insufficient: a fake that accepts any
queue name is how an invalid topic can stay green.

### 3. Preserve default-prefix behavior

Keep explicit coverage that a genuinely un-namespaced run persists null/absent
namespace and recovers to `__wkf_workflow_<name>`.

### 4. Cover upgrade behavior deliberately

Add a migration test for an existing `workflow_runs` row created before the new
column. A legacy null is ambiguous: it can mean a genuinely un-namespaced run,
or a namespaced run created before persistence existed. Do not silently declare
all legacy nulls safe defaults.

## Recommended implementation direction

The smallest coherent fix for newly created runs is likely:

1. Add a nullable `queue_namespace` column to `workflow.workflow_runs` in a new
   migration and in `src/drizzle/schema.ts`.
2. Pass the already-resolved namespace from `createWorld()` into the storage
   layer.
3. Set it when a run row is first inserted in both production creation paths:
   resilient start and `run_created`. Treat it as immutable provenance for that
   run; later events must not overwrite it from another process.
4. Select `queue_namespace` in external boot recovery and copy it onto the
   synthetic `MessageData` when non-null.
5. Update `src/message.ts` documentation: absent means the default prefix only
   when the run is known to have been created by an un-namespaced world. It is
   not a generally safe inference for pre-migration rows.

Do not:

- resolve `WORKFLOW_QUEUE_NAMESPACE` in the dispatcher process;
- infer the namespace by hex-decoding or reimplementing Eve's package-name
  algorithm;
- use queue prefixes as tenant isolation;
- change Deployment affinity for a recovered run;
- edit an already-published migration;
- patch the installed package under Eveland's `node_modules`.

### Legacy active-run decision

Before publishing, make an explicit compatibility decision for active rows
whose new column is null. Plausible options include a durable per-Deployment
namespace registration or an operator-visible drain/cancel upgrade procedure.
The current control-plane activation response does not return a namespace, and
immutable old Releases cannot be assumed to run new registration code.

Because the package README says the shared-world path has not carried
production traffic yet, an explicit pre-release drain/cancel policy may be
acceptable, but it must be documented and tested rather than hidden behind
"null means default."

## Publish and consume the fix

After the upstream fix and its real Postgres tests pass:

1. Publish a new `@evelandhq/workflow-world` version; this is a bug fix, but
   choose the version according to the upstream package's release policy.
2. In Eveland, update both consumer dependency ranges:
   `apps/worker/package.json` and `apps/workflow-dispatcher/package.json`.
3. Update `EVELAND_WORKFLOW_WORLD.packageVersion` in
   `apps/worker/src/runtime/workflow-world.ts` to the exact installed version.
4. Refresh `pnpm-lock.yaml` without changing unrelated packages.
5. Strengthen the Eveland wake E2E so it registers a real workflow, proves body
   resumption after idle/restart, and requires zero dead letters.
6. If legacy active runs require operator action, add the matching upgrade note
   and operational documentation in the same change.

## Verification expectations

Upstream workflow-world:

```bash
npm test
npm run typecheck
npm run build
npm run lint
npm run fmt:check
EVELAND_WORKFLOW_WORLD_TEST_URL=<scratch-postgres-url> npm test
npm run test:conformance
npm run test:e2e
```

Report which integration suites were actually run; do not describe a skipped
Postgres suite as verified.

Eveland after consuming the published package:

```bash
pnpm --filter @evelandhq/architecture-tests test
pnpm --filter @evelandhq/worker typecheck
pnpm --filter @evelandhq/workflow-dispatcher typecheck
pnpm test
pnpm typecheck
pnpm build
pnpm lint
pnpm fmt:check
git diff --check
git status --short
```

Run the real workflow wake path with its required Docker/Postgres topology. The
final acceptance condition is not merely
"Deployment woke": a namespaced workflow body must resume and the tenant must
have zero dead letters.

## Open questions for the implementation session

1. Is persisting namespace per run sufficient for every supported Eve
   continuation path, or should the package also keep an immutable
   per-Deployment registration?
2. What is the supported upgrade behavior for active pre-migration rows with a
   null namespace?
