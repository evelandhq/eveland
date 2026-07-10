# systemd becomes the production default (PR 4 of 4)

The final PR of the systemd-production effort: with topology (PR 1), recorded
`runtimeKind` + real lifecycle (PR 2), and failure cleanup + de-privileged builds
(PR 3) all merged, the default runtime can flip. `NODE_ENV=production` with no
explicit `EVELAND_RUNTIME` now resolves to systemd; development and CI keep docker;
an explicit `EVELAND_RUNTIME` always wins (legacy Docker production installs set it
and are unaffected — both compose files already pin it explicitly since PR 1).

Also closes the small carry-overs accumulated in PR 2/3 final reviews, and adds a
VM-level proof that a failed health check leaves no residue.

Pre-verified non-issue (do NOT "fix"): the legacy `docker-worker` profile inherits
`WORKFLOW_POSTGRES_URL` pointing at `host.docker.internal` from the base compose
file. The docker adapter starts every agent container with
`--add-host host.docker.internal:host-gateway` (apps/worker/src/runtime/docker.ts,
buildDockerRunArgs), so the injected URL resolves inside deployed agent containers
on Linux; the worker itself never dials that URL. Task 1 adds a one-line comment in
the prod overlay so the next reader doesn't re-open this.

## Global Constraints

- Resolution precedence is exactly: explicit `EVELAND_RUNTIME` > `NODE_ENV ===
  "production"` → `"systemd"` > `"docker"`. Unknown explicit values still throw the
  existing error.
- No behavior change for: base compose dev (pins docker), prod overlay legacy
  profile (pins docker), the host worker env example (pins systemd), CI (no
  NODE_ENV=production).
- Docs claims must be true of the code. ESM `.js` imports, vitest, TDD for behavior
  changes, comments only for non-obvious constraints. No `git stash`. Run touched
  packages' suites + `tsc --noEmit` before reporting DONE.

## Task 1: Default flip in select.ts + docs

**Files:**
- Edit `apps/worker/src/runtime/select.ts`
- Edit `apps/worker/src/runtime/select.test.ts`
- Edit `docs/deploy/linux.md`
- Edit `infra/systemd/eveland-worker.env.example`
- Edit `docker-compose.prod.yml` (one comment line)

**select.ts:** extract and export the resolution so it is testable in isolation:

```ts
export function resolveRuntimeKind(env: NodeJS.ProcessEnv): string {
  if (env.EVELAND_RUNTIME) {
    return env.EVELAND_RUNTIME;
  }
  if (env.NODE_ENV === "production") {
    return "systemd";
  }
  return "docker";
}
```

`createRuntimeAdapterFromEnv` uses it in place of `env.EVELAND_RUNTIME ?? "docker"`;
the unknown-kind throw stays where it is (an explicit garbage value must still
error, and `resolveRuntimeKind` never returns garbage on its own). Comment on the
function: why production defaults to systemd (this is the supported production
shape) while dev/CI stay docker, and that explicit configuration always wins so
legacy Docker production hosts opt out with one env var.

**select.test.ts (TDD):** `NODE_ENV=production` + unset `EVELAND_RUNTIME` → systemd
adapter; `NODE_ENV=production` + `EVELAND_RUNTIME=docker` → docker (explicit wins);
unset both → docker; `NODE_ENV=test`/`development` → docker; unknown explicit value
still throws. Test `resolveRuntimeKind` directly for the same matrix.

**docs/deploy/linux.md:** `EVELAND_RUNTIME` table row: default is now
"`docker`; `systemd` when `NODE_ENV=production`" with a sentence that explicit
config wins. Check the runtime-switch warning section and the Production topology
section for any sentence that still says the default is docker unconditionally.

**eveland-worker.env.example:** keep `EVELAND_RUNTIME=systemd` but amend its
comment: explicit here for clarity; since PR 4 a production worker (NODE_ENV=production)
defaults to systemd anyway.

**docker-compose.prod.yml:** one comment line on the legacy worker's
`WORKFLOW_POSTGRES_URL`-inheriting environment noting host.docker.internal resolves
inside deployed agent containers via the docker adapter's `--add-host ...:host-gateway`
(pre-verified; see plan preamble).

## Task 2: Review carry-overs — preflight traversal probe, restart guard test, doc wording

**Files:**
- Edit `apps/worker/src/runtime/preflight.ts`
- Edit `apps/worker/src/runtime/preflight.test.ts`
- Edit `apps/worker/src/jobs/process.test.ts`
- Edit `docs/deploy/linux.md`

**Preflight:** check 9 currently probes only `canTraverseAs(appUser, dataDir)`. Add
the build-user sibling probe (`canTraverseAs(buildUser, dataDir)`) with its own
issue message (the build runs as the build user under `<dataDir>/builds` and the
npm cache; a non-traversable ancestor fails the first build with a confusing npm
EACCES). Same skip semantics as the app-user probe: skipped when the build user
does not exist or the data dir could not be created. Tests: build-user traversal
failure flagged (app user passing); probe skipped when build user missing; all-pass
still passes.

**Restart guard-branch test (process.test.ts):** one new test pinning the
`restarted` flag's false branch: `adapter.startProcess` rejects during restart →
`stopProcess` was called exactly once (the pre-restart stop), not twice, and the
job fails with the startProcess error.

**linux.md wording fixes (from PR 3's re-review):**
1. The build-env sentence that lists the allowlist as "PATH, HOME, and
   npm_config_cache": HOME is not in the execa allowlist — it is injected after the
   user switch (bwrap `--setenv` / `env` wrapper), and runuser also sets
   SHELL/USER/LOGNAME. Make the sentence precise.
2. Add one sentence noting the allowlist deliberately drops operator proxy vars
   (`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`, `npm_config_registry`): builds on
   proxied hosts need a mirror reachable without env-borne proxy config today (a
   passthrough knob is possible future work).

## Task 3: VM proof of failure cleanup + reboot-recovery known limit

**Files:**
- Edit `apps/worker/src/integration/systemd-smoke.ts`
- Edit `docs/deploy/linux.md`

**systemd-smoke.ts:** after the existing deploy/restart/delete flow (which ends with
the project deleted), add a failed-deploy proof in the script's established style:
1. Create a second fixture project whose start command binds nothing (reuse the
   existing fixture-creation helper with a start script like `sh -lc "sleep 30"`,
   or the equivalent the script's fixture supports — the health check must time
   out). Use a short `EVELAND_HEALTH_TIMEOUT_MS` for this step only (settable via
   the job options/process env within the script) so the step runs in seconds.
2. Enqueue `build_deploy`, run `processNextJob`, assert it reports the job FAILED
   (returns true; project deploymentStatus "failed").
3. Assert no residue: no `eveland-*` unit for that project is active, its
   deployment-env file does not exist, and the deployment's port is free (connect
   attempt fails). Print `CLEANUP OK`.
4. Clean up the fixture rows if the script's teardown expects it (deletion via the
   existing delete_project path is fine and re-proves it).

**docs/deploy/linux.md — Known limits:** add the honest gap the roadmap's
verification list surfaced: deployed agents run as systemd *transient* units, which
do not survive a host reboot; the worker itself does (installed unit), but
deployments must be redeployed/restarted after boot until a reconciliation loop
exists (explicitly future work, PR 5+ territory). State it plainly rather than
implying reboot recovery works.

**Verification:** smoke compiles (`tsc --noEmit`); `bash -n infra/integration/run.sh`.
