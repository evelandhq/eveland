# Deployment runtimeKind + real lifecycle (PR 2 of 4)

Deployments currently don't record which runtime created them, so nothing can ever
stop a process made under a different `EVELAND_RUNTIME` than the worker's current one.
This PR adds `runtimeKind` to every deployment and makes the three lifecycle paths
real: restart actually bounces the process, redeploy stops the old process with the
adapter that owns it, and project deletion stops the running process before deleting
rows. Migration stance (documented, not enforced): drain Docker deployments before
switching a host's runtime; the new column's job is to make mixed state visible and
stoppable, not to make mixed hosts a supported topology.

## Global Constraints

- `RuntimeKind` is the string union `"docker" | "systemd"`, defined once in
  `apps/api/src/types.ts` and imported everywhere else (the worker's
  `RuntimeAdapter.name` narrows to it structurally — worker code must not add a
  parallel union type).
- The Drizzle migration must be safe on a non-empty `deployments` table: add the
  column with `DEFAULT 'docker'` (every existing row predates the systemd runtime),
  then `DROP DEFAULT` so future inserts must set it explicitly. `schema.ts` declares
  the column `.notNull()` with **no** default.
- Every store change lands in BOTH `createMemoryStore` (apps/api/src/store.ts) and
  the Postgres store (apps/api/src/db/postgres-store.ts), with the memory-store
  behavior covered in apps/api/src/store.test.ts. The two stores must stay
  behaviorally identical.
- Never `appendLog` or `updateProjectState` for a project after `deleteProject` has
  removed it — the Postgres store enforces FK integrity and would throw.
- Adapters are resolved per-deployment via the recorded `runtimeKind`, injectable in
  tests through `ProcessJobOptions`. Restarting/stopping a deployment whose runtime
  isn't available on this host (e.g. a docker deployment on a systemd host) is
  allowed to fail loudly — a logged job failure, never a silent no-op.
- Follow existing code style: ESM imports with `.js` suffixes, vitest, comments only
  for non-obvious constraints. Run the touched packages' test suites before
  reporting DONE.

## Task 1: Data layer — runtimeKind column, release/revision lookups

**Files:**
- Edit `apps/api/src/types.ts`
- Edit `apps/api/src/db/schema.ts`
- Generate + hand-edit a new migration under `apps/api/drizzle/`
- Edit `apps/api/src/db/mappers.ts`
- Edit `apps/api/src/store.ts` (interface + memory store)
- Edit `apps/api/src/db/postgres-store.ts`
- Edit `apps/api/src/store.test.ts`
- Edit `apps/api/src/db/mappers.test.ts`

**types.ts:**
- Add `export type RuntimeKind = "docker" | "systemd";`
- Add `runtimeKind: RuntimeKind;` to `DeploymentRecord`.

**schema.ts:** add to the `deployments` table: `runtimeKind: text("runtime_kind").notNull(),` (no default — see Global Constraints).

**Migration:** run `pnpm --filter @eveland/api db:generate` after the schema edit, then
hand-edit the generated SQL so it is safe on a non-empty table:

```sql
ALTER TABLE "deployments" ADD COLUMN "runtime_kind" text NOT NULL DEFAULT 'docker';
ALTER TABLE "deployments" ALTER COLUMN "runtime_kind" DROP DEFAULT;
```

(The snapshot JSON drizzle-kit writes stays as generated — it reflects schema.ts,
which has no default.) State in your report that the SQL was hand-edited and why.

**mappers.ts:** `deploymentRowToDeployment` gains `runtimeKind: row.runtimeKind as RuntimeKind` (and its row type gains `runtimeKind: string`). Update mappers.test.ts fixtures.

**Store interface (store.ts):**
- `recordDeployment` input gains `runtimeKind: RuntimeKind` (required).
- New method `getRelease(releaseId: string): Promise<ReleaseRecord | null>`.
- New method `getSourceRevision(revisionId: string): Promise<SourceRevision | null>`
  (by revision id — the existing `getCurrentSourceRevision` is by project and only
  returns the latest; restart needs the revision of the *deployed* release).

**Memory store:** implement all three (deployments store the field; lookups scan
`state.releases` / `state.sourceRevisions`).

**Postgres store:** implement all three (`recordDeployment` inserts the column; the
lookups select by primary key and reuse the existing row→record mappers; add a
release mapper if none exists).

**Tests (store.test.ts):** recordDeployment round-trips `runtimeKind`;
`getRelease`/`getSourceRevision` return the record by id and null when absent. Update
every existing `recordDeployment` call site in tests to pass a `runtimeKind`.

Compile check: `pnpm --filter @eveland/api test` and
`pnpm --filter @eveland/api exec tsc --noEmit` (worker still fails to compile until
Task 3 updates its `recordDeployment` call — verify only the api package here, and
note the expected worker breakage in your report so the controller knows it is
planned).

## Task 2: Per-kind adapter construction

**Files:**
- Edit `apps/worker/src/runtime/types.ts`
- Edit `apps/worker/src/runtime/select.ts`
- Edit `apps/worker/src/runtime/select.test.ts`

**types.ts:** narrow `RuntimeAdapter.name` from `string` to `"docker" | "systemd"`
(structural match for the api's `RuntimeKind`; do not import api types here).

**select.ts:** refactor so kind resolution and construction are separable:

```ts
export function createRuntimeAdapterForKind(kind: "docker" | "systemd", env: NodeJS.ProcessEnv = process.env): RuntimeAdapter
```

containing the existing docker/systemd construction bodies verbatim (including the
`resolveBackendDistDir` provider wiring). `createRuntimeAdapterFromEnv` becomes: read
`env.EVELAND_RUNTIME ?? "docker"`, throw the existing unknown-kind error for anything
that is not `"docker"`/`"systemd"`, and delegate to `createRuntimeAdapterForKind`.
Behavior of `createRuntimeAdapterFromEnv` is unchanged — existing tests must pass
untouched except for imports.

**select.test.ts:** add coverage that `createRuntimeAdapterForKind("docker"|"systemd")`
returns an adapter whose `.name` matches, and that `createRuntimeAdapterFromEnv` still
rejects unknown kinds.

Run `pnpm --filter @eveland/worker exec vitest run src/runtime/select.test.ts` (the
full worker suite may still fail to compile on the Task 1 interface change — that is
Task 3's job; run the focused file and `tsc --noEmit` scoped reporting only select.ts
status, and note remaining breakage in your report).

## Task 3: build_deploy records runtimeKind; redeploy stops the old runtime's process

**Files:**
- Edit `apps/worker/src/jobs/process.ts`
- Edit `apps/worker/src/jobs/process.test.ts`

**ProcessJobOptions:** add
`runtimeForKind?: (kind: "docker" | "systemd") => RuntimeAdapter` — test injection
point mirroring the existing `runtime` option.

**In `build_deploy`:**
- `recordDeployment` call passes `runtimeKind: runtime.name`.
- Replace the current-deployment stop (`await runtime.stopProcess(currentDeployment.containerName)`)
  with a stop through the adapter that owns the old deployment:

```ts
const stopAdapter = currentDeployment.runtimeKind === runtime.name
  ? runtime
  : (options.runtimeForKind ?? createRuntimeAdapterForKind)(currentDeployment.runtimeKind);
await stopAdapter.stopProcess(currentDeployment.containerName);
```

with a comment stating the constraint: each adapter can only stop its own kind of
process, and the old deployment's kind is authoritative, not the worker's current
runtime.

**Tests (process.test.ts):** existing fake-runtime tests updated for the new
`recordDeployment` field (assert the stored deployment carries the fake runtime's
name). New test: a current deployment recorded with the *other* runtimeKind causes
`runtimeForKind` to be called with that kind and the returned adapter's `stopProcess`
to receive the old containerName, while the active runtime's `stopProcess` is not
called for it.

After this task the worker package must compile again: run the full
`pnpm --filter @eveland/worker test` and `tsc --noEmit`.

## Task 4: restart_deployment actually restarts

**Files:**
- Edit `apps/worker/src/jobs/process.ts`
- Edit `apps/worker/src/jobs/process.test.ts`

Extract from `build_deploy` a helper used by both paths (same file):

```ts
async function composeDeploymentEnv(store: Store, projectId: string, options: ProcessJobOptions): Promise<{ env: Record<string, string>; secretValues: string[] }>
```

covering what build_deploy currently assembles: decrypted project secrets,
platform-injected `WORKFLOW_POSTGRES_URL` (project secret of the same name wins), and
`NODE_ENV=production` when in production. build_deploy's durable-workflow *gating*
stays in build_deploy — restart never re-gates an already-deployed release.

**New `restart_deployment` handler** (replacing the status-flip stub):
1. Load project (throw if missing) and current deployment (throw
   `"No deployment to restart."` if none — the job fails and the existing
   failure path marks the project failed).
2. `getRelease(deployment.releaseId)` and `getSourceRevision(release.sourceRevisionId)`
   (throw if either is missing — a deployment without its release/revision is
   corrupt state worth failing loudly on).
3. Keep the existing "Restart requested." log and `deploymentStatus: "starting"`
   update at the top.
4. Resolve the adapter from `deployment.runtimeKind` via
   `options.runtime ?? (options.runtimeForKind ?? createRuntimeAdapterForKind)(deployment.runtimeKind)`.
5. `composeDeploymentEnv`, `resolveRuntimeCommandContext(revision.sourcePath)`.
6. `stopProcess(deployment.containerName)`, then `startProcess` with the same
   `processName`/`hostPort`/release ref (`release.imageTag`) and the project's
   sandbox cache dir (same `resolveProjectSandboxCacheDir(resolveSandboxCacheRoot(...))`
   pair build_deploy uses).
7. Health-check via the existing `options.waitForDeployment ?? waitForHttpHealth`
   with the same timeout env.
8. On success: `deploymentStatus: "running"` and a log line naming the port.

**Tests:** with fake runtime + fake store state (project, revision, release,
deployment with runtimeKind): restart calls stop then start on the *deployment's*
kind adapter with the recorded containerName/hostPort/releaseRef; secrets and
WORKFLOW_POSTGRES_URL appear in the start env; restart with no deployment fails the
job and marks the project failed; restart with a missing release record fails.
Full worker suite green.

## Task 5: delete_project stops the process before deleting rows

**Files:**
- Edit `apps/api/src/types.ts` (JobType union)
- Edit `apps/api/src/app.ts` (DELETE endpoint)
- Edit `apps/api/src/app.test.ts`
- Edit `apps/web/src/lib/api.ts` (Job type union — one line)
- Edit `apps/worker/src/jobs/process.ts` (new job handler)
- Edit `apps/worker/src/jobs/process.test.ts`

**types.ts:** `JobType` gains `"delete_project"`.

**app.ts:** `DELETE /projects/:projectId` becomes async: 404 `{ error: "Project not found" }`
when the project doesn't exist; otherwise `enqueueJob(projectId, "delete_project")`
and return `202 { job }` (mirrors the restart endpoint). No web code consumes the old
`{ deleted }` shape (verified — the web app never calls this endpoint).

**app.test.ts:** DELETE on a missing project → 404; DELETE on an existing project →
202 with a `delete_project` job, and the project still exists until the worker runs.

**Worker handler (`process.ts`):**
1. `getProject` — if already gone, return silently (idempotent re-run of a
   half-finished delete).
2. `getCurrentDeployment` — if present, log
   `"Stopping deployment before deleting project."`, resolve the adapter from the
   deployment's `runtimeKind` (same `options.runtime ?? runtimeForKind` pattern) and
   `stopProcess(deployment.containerName)`.
3. `store.deleteProject(projectId)` **last**, and nothing — no log, no state update —
   after it (Global Constraints; also note `completeJob` on the already-deleted job
   row is a verified no-op in both stores).

Also: the generic failure path in `processNextJob` calls `updateProjectState` +
`appendLog` — both are safe when the project is already gone only in the memory
store; for `delete_project` failures the project always still exists (deletion is the
last step), so no change needed there — but state this reasoning in a short comment
on the handler.

**Tests:** delete_project with a running deployment stops it via the deployment's
runtimeKind adapter then deletes the project; delete_project with no deployment just
deletes; delete_project for an already-deleted project completes without error;
verify no log is appended after deletion (store spy ordering).

Full api + worker + web suites green.

## Task 6: Integration coverage and docs

**Files:**
- Edit `apps/worker/src/integration/systemd-smoke.ts`
- Edit `docs/deploy/linux.md`

**systemd-smoke.ts:** after the existing deploy + health-check + fetch steps, extend
the script (keep its style and its final teardown):
1. Read the unit's `MainPID` (`systemctl show --property=MainPID --value <unit>`).
2. Enqueue `restart_deployment` via the same store, `processNextJob`, assert it
   reports success, the unit's MainPID **changed**, and the HTTP endpoint still
   answers. Print `RESTART OK`.
3. Enqueue `delete_project`, `processNextJob`, assert the unit is no longer active
   (`systemctl is-active` fails), the deployment-env file for the unit is gone, and
   the store no longer has the project. Print `DELETE OK`.
   (This replaces any existing manual teardown of the same unit if the script has
   one — deletion IS the teardown now; keep any unrelated cleanup.)

**docs/deploy/linux.md:** in the existing runtime-switch warning section, add that
deployments now record their `runtimeKind`, so stops/restarts/deletes always use the
adapter that created the process — the drain-first guidance still stands for hosts
being migrated, and old rows are backfilled as `docker` by the migration. Document
that project deletion is now asynchronous (a `delete_project` job) and stops the
running process first. Mention `pnpm --filter @eveland/api db:generate`/`db:push` as
the migration mechanism for existing installs.

**Verification:** `bash -n infra/integration/run.sh` still passes (file untouched but
it invokes the smoke); the smoke script itself compiles
(`pnpm --filter @eveland/worker exec tsc --noEmit`).
