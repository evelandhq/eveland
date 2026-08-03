# Deploy failure cleanup + build de-privileging (PR 3 of 4)

Two gaps stand between the systemd runtime and flipping the production default:
a failed deploy leaves its just-started process running (crash-looping unit, decrypted
EnvironmentFile on disk, held port) while the project is marked failed, and the build
step — `npm ci`/`npx eve build`, i.e. arbitrary third-party lifecycle scripts — runs
as root with read access to the whole host outside the bwrap mask. This PR makes
started-but-unhealthy processes get stopped on the failure path, and moves the build
onto a dedicated unprivileged `eveland-build` user. It also lands two small
carry-overs from PR 2's final review: transactional Postgres `deleteProject` and a
loud restart failure when the deployed revision's source dir is missing.

## Global Constraints

- Failure cleanup must never mask the original error: the cleanup `stopProcess` is
  wrapped in its own try/catch; a cleanup failure is logged (`type: "runtime"`) and
  the ORIGINAL error is rethrown.
- The build user is platform configuration: `EVELAND_BUILD_USER` (default
  `eveland-build`), alongside the existing `EVELAND_APP_USER` (default `eveland-app`).
  The docker runtime is untouched (its build runs inside `docker build`).
- Build-time file ownership handover is root's job: root prepares the release and
  npm cache, hands them to the build user, runs the build as that user, then hands
  the release to the app user. The sandbox self-check keeps running as the app user.
- The two stores stay behaviorally identical; anything Postgres-transactional must
  keep the same observable results as the memory store.
- ESM `.js` imports, vitest, comments only for non-obvious constraints. Run the
  touched packages' suites + `tsc --noEmit` before reporting DONE. No `git stash`.

## Task 1: build_deploy and restart stop the process they started when the deploy fails

**Files:**

- Edit `apps/worker/src/jobs/process.ts`
- Edit `apps/worker/src/jobs/process.test.ts`

**In `build_deploy`:** everything from `runtime.startProcess(...)` through
`recordDeployment`/`updateProjectState`/final log runs inside a try/catch that tracks
the started process:

```ts
let startedProcess: string | null = null;
try {
  const started = await runtime.startProcess({ ... });
  startedProcess = processName;
  await (options.waitForDeployment ?? waitForHttpHealth)({ ... });
  // recordDeployment, updateProjectState, success log — unchanged
} catch (error) {
  if (startedProcess) {
    try {
      await runtime.stopProcess(startedProcess);
    } catch (cleanupError) {
      await store.appendLog({ projectId: job.projectId, type: "runtime",
        line: `Cleanup after failed deploy also failed: ${message-of(cleanupError)}` });
    }
  }
  throw error;
}
```

The old-deployment stop and the build itself stay OUTSIDE this block (a build failure
starts nothing, so there is nothing to clean; the old-deployment stop already
happened and must not be repeated). Note the systemd adapter's `stopProcess` already
removes the EnvironmentFile and the unit's exit frees the port — stopping the started
process IS the full cleanup; state a one-line comment to that effect.

**In `restart_deployment`:** same pattern around its `startProcess` + health check:
if the freshly restarted process fails its health check, stop it (same
cleanup-failure logging), then rethrow. A restart that cannot come up healthy must
not leave a crash-looping unit behind while the project reads failed.

**Tests (TDD, RED first):**

- build_deploy: fake runtime whose `startProcess` succeeds and injected
  `waitForDeployment` rejects → the fake's `stopProcess` is called with the NEW
  processName (assert it is the started name, not the old deployment's), no
  deployment is recorded, project/deployment status end failed.
- build_deploy: `startProcess` itself rejects → `stopProcess` is NOT called for the
  new process (nothing started).
- build_deploy: health fails AND `stopProcess` also rejects → job still fails with
  the ORIGINAL health error message, and a runtime log line records the cleanup
  failure.
- restart: health check rejects → the restarted process is stopped (stop called
  twice overall: once for the restart itself, once for cleanup), job fails.
- Existing tests must pass unchanged.

## Task 2: systemd build runs as the unprivileged build user

**Files:**

- Edit `apps/worker/src/runtime/systemd.ts`
- Edit `apps/worker/src/runtime/select.ts`
- Edit `apps/worker/src/runtime/systemd.test.ts`
- Edit `apps/worker/src/runtime/select.test.ts` (only if construction wiring needs it)

**`SystemdAdapterConfig`** gains `buildUser: string`. `select.ts` passes
`env.EVELAND_BUILD_USER ?? "eveland-build"` in `createRuntimeAdapterForKind`.

**`buildRelease` flow becomes** (order matters; each step keeps its existing comment
where one exists):

1. mkdir releaseDir + npmCacheDir, `cp -a` source, `injectSandboxModules`, mkdir
   sandbox cacheDir — all as the worker (root), unchanged.
2. NEW: `chown -R <buildUser>:` releaseDir AND npmCacheDir (npm cache may be
   root-owned from installs predating this change; a recursive chown per build is
   the accepted correctness-first cost — note it in a comment).
3. The build command execution is wrapped with `runuser`:
   - bwrap mode: `execa("runuser", ["-u", buildUser, "--", "bwrap", ...buildBwrapArgs({...})], { all: true, env: { npm_config_cache: npmCacheDir, HOME: releaseDir } })`
   - none mode: `execa("runuser", ["-u", buildUser, "--", "sh", "-lc", command], { all: true, cwd: releaseDir, env: { npm_config_cache: npmCacheDir, HOME: releaseDir } })`
   - `HOME=releaseDir` is required: the build user cannot read root's `$HOME`, and
     npm consults `$HOME/.npmrc`. State this in a comment.
   - Export a small pure helper for the wrapped argv (mirroring `buildBwrapArgs`'s
     testability), e.g. `buildRunAsUserArgs(user: string, argv: string[]): string[]`.
4. `chown -R <appUser>:` releaseDir + cacheDir, then `verifySandbox` as the app
   user — unchanged.

The unprivileged bwrap invocation relies on the same AppArmor grant the deployed
agent's sandbox already requires (`/etc/apparmor.d/bwrap`, userns) — the Lima VM and
docs already provision it; reference that in a comment rather than re-documenting.

**Tests:** systemd.test.ts mocks execa — assert the build invocation is now
`runuser -u <buildUser> -- bwrap ...` (and `runuser -u <buildUser> -- sh -lc ...` in
none mode), that `HOME` is set to the release dir in the exec env, that the
chown-to-buildUser calls happen before the build call and chown-to-appUser after
(mock call order), and `buildRunAsUserArgs` unit tests. Existing assertions about
bwrap args themselves must keep passing (the inner argv is unchanged).

## Task 3: preflight, infra, and docs for the build user

**Files:**

- Edit `apps/worker/src/runtime/preflight.ts`
- Edit `apps/worker/src/runtime/preflight.test.ts`
- Edit `infra/systemd/eveland-worker.env.example`
- Edit `infra/lima/eveland.yaml`
- Edit `infra/integration/run.sh`
- Edit `docs/deploy/linux.md`

**Preflight:** the app-user existence check (check 6) gains a sibling: the build user
(`env.EVELAND_BUILD_USER ?? "eveland-build"`) must exist; issue message names
`EVELAND_BUILD_USER` and the `useradd` fix. `runuser` joins the required-binaries
list (the build path now depends on it; it was previously only used by the
traversal probe). Tests: missing build user flagged; `runuser` missing flagged;
all-pass fixture updated.

**`eveland-worker.env.example`:** add `#EVELAND_BUILD_USER=eveland-build` to the
optional block, right above `#EVELAND_APP_USER=eveland-app`.

**`infra/lima/eveland.yaml`:** provision the build user next to the app user:
`id eveland-build || useradd --system --home-dir /var/lib/eveland-build --create-home eveland-build`.

**`infra/integration/run.sh`:** existing VMs never re-provision — add the same
`id -u eveland-build >/dev/null 2>&1 || useradd --system --home-dir /var/lib/eveland-build --create-home eveland-build`
guard next to the existing git guard.

**`docs/deploy/linux.md`:**

- Host prerequisites: a second service user for builds
  (`useradd --system --home-dir /var/lib/eveland-build --create-home eveland-build`).
- Worker configuration table: `EVELAND_BUILD_USER` row (default `eveland-build`,
  meaning: unix user the build — `npm ci`/`npx eve build`, i.e. third-party
  lifecycle scripts — runs as).
- Update the build-trust note: the build no longer runs as root; it runs as the
  unprivileged build user inside bwrap, so lifecycle scripts lose root's read
  access to the host (the bwrap mask still hides the data dir). Remove/replace the
  "dropping the build uid via bwrap --uid is a planned follow-up hardening"
  sentence — this PR is that hardening (delivered via `runuser`, not `--uid`).
- Startup preflight section: add the build user and `runuser` to the named checks.

## Task 4: carry-overs — transactional deleteProject, loud restart on missing source

**Files:**

- Edit `apps/api/src/db/postgres-store.ts`
- Edit `apps/worker/src/jobs/process.ts`
- Edit `apps/worker/src/jobs/process.test.ts`

**Transactional `deleteProject` (Postgres):** wrap the existing cascade in
`db.transaction(async (tx) => { ... })` (precedent at postgres-store.ts:471),
switching every statement inside to `tx`. Observable behavior is unchanged (same
return value); a mid-cascade crash no longer half-deletes (previously it could
remove the job row before the project row, losing the retry trail). Memory store
needs no change (single-threaded synchronous mutation). No new test required — no
Postgres test harness exists in this repo; state that in the report.

**Loud restart on missing source dir:** in `restart_deployment`, after
`getSourceRevision`, verify the revision's `sourcePath` still exists on disk
(`access`); if not, throw
`Source directory for revision <id> is missing: <path>. Re-import the source and deploy instead.`
Rationale (comment): `readPackageJson` swallows a vanished dir into
`{isEveProject:false}` and restart would silently launch the wrong start command.
Test: fake store returns a revision whose sourcePath does not exist → restart job
fails with that message, and the deployment's process was NOT stopped (the check
runs before any stop).

Run full api + worker suites + `tsc --noEmit`.
