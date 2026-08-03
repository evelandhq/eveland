# systemd production topology (PR 1 of 4)

Make the systemd runtime the supported production shape: API/Web/Postgres stay in
Compose, the worker moves onto the Linux host as a root systemd service. This PR
establishes the topology and fails fast on missing host prerequisites; later PRs add
`runtimeKind` on deployments, failure cleanup + build de-privileging, and the default
switch.

## Global Constraints

- The unified production data directory is the absolute path `/var/lib/eveland`.
  The API container bind-mounts the host directory at the **same absolute path** so
  `sourcePath` values stored in the database resolve identically for the API container
  and the host worker.
- Local development behavior must not change: `docker compose up` with the base
  `docker-compose.yml` keeps running the containerized worker with the Docker runtime.
- Preflight checks run only when `EVELAND_RUNTIME=systemd`; with the Docker runtime the
  preflight is a no-op. Preflight collects **all** failures and reports them in a single
  error, not just the first one.
- Follow existing code style: ESM imports with `.js` suffixes, vitest for tests,
  comments only for non-obvious constraints (match the density of
  `apps/worker/src/runtime/systemd.ts`).
- Run `pnpm --filter @eveland/worker test` (and any other touched package's tests)
  before reporting DONE.

## Task 1: Worker startup preflight for the systemd runtime

**Files:**

- Create `apps/worker/src/runtime/preflight.ts`
- Create `apps/worker/src/runtime/preflight.test.ts`
- Create `apps/worker/src/integration/preflight-check.ts`
- Edit `apps/worker/src/runtime/select.ts` (export the existing `resolveBackendDistDir`)
- Edit `apps/worker/src/worker.ts` (run preflight before the poll loop starts)

**Behavior:**

`preflight.ts` exports:

```ts
export type PreflightDeps = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform; // default process.platform
  getuid: () => number; // default process.getuid?.() ?? -1
  pathExists: (p: string) => Promise<boolean>; // default fs access
  isDirectory: (p: string) => Promise<boolean>; // default fs stat
  mkdir: (p: string) => Promise<void>; // default fs mkdir recursive
  commandExists: (name: string) => Promise<boolean>; // default: `command -v <name>` exit 0
  userExists: (name: string) => Promise<boolean>; // default: `id -u <name>` exit 0
  canTraverseAs: (user: string, dir: string) => Promise<boolean>;
  // default: `runuser -u <user> -- test -x <dir>` exit 0
  backendDistDir: () => string; // default: resolveBackendDistDir from select.ts
};

export async function collectSystemdPreflightIssues(deps: PreflightDeps): Promise<string[]>;
export async function assertWorkerPreflight(
  env: NodeJS.ProcessEnv,
  overrides?: Partial<PreflightDeps>,
): Promise<void>;
```

`assertWorkerPreflight`:

- Returns immediately (no checks) unless `env.EVELAND_RUNTIME === "systemd"`.
- Otherwise runs `collectSystemdPreflightIssues` with default deps merged with
  `overrides`, and throws a single `Error` whose message starts with
  `"systemd runtime preflight failed:"` followed by every issue on its own `- ` line,
  if there are any issues.

`collectSystemdPreflightIssues` checks, in order, and appends one human-readable issue
string per failure (every string must name the failing thing and how to fix it):

1. Platform is `linux`.
2. systemd is present: `/run/systemd/system` exists.
3. Running as root: `getuid() === 0` (the worker drives `systemd-run`, `systemctl`,
   `chown`).
4. `env.EVELAND_DATA_DIR` is set and `path.isAbsolute` — the API container and host
   worker must agree on stored `sourcePath` values, so a relative default is an error
   under systemd. Recommend `/var/lib/eveland` in the message.
5. Required binaries exist via `commandExists`: `systemd-run`, `systemctl`, `node`,
   plus `bwrap` unless `env.EVELAND_BUILD_SANDBOX === "none"`.
6. The app user exists (`env.EVELAND_APP_USER ?? "eveland-app"`) via `userExists`.
7. `/workspace` exists and is a directory (bwrap bind destination; see
   `sandbox-verify.ts`).
8. The sandbox backend is built: `backendDistDir()` does not throw. Catch and convert
   the thrown message into an issue.
9. The data dir is usable: `mkdir` it (recursive, ignore already-exists), then the app
   user can traverse it (`canTraverseAs(appUser, dataDir)`) — releases under
   `<dataDir>/builds` are chowned to the app user, but a non-traversable ancestor
   (e.g. 0700) still blocks the unit at start.

Checks 4–9 must still run when earlier checks fail **except**: skip 9's traversal probe
when 6 failed (no user to probe as), and skip 8/9 gracefully if their inputs are missing
(no data dir set → nothing to mkdir; report only issue 4).

In `select.ts`, export the currently-private `resolveBackendDistDir` unchanged so
preflight reuses it (keep its doc comment; do not duplicate the logic).

In `worker.ts`, before the first `tick()`, call
`await assertWorkerPreflight(process.env)`; on throw, log the error message and
`process.exit(1)`. Keep the existing startup log lines.

`preflight-check.ts` (integration entry, mirrors the style of
`src/integration/systemd-smoke.ts` invocation): calls
`assertWorkerPreflight(process.env)` and prints `PREFLIGHT OK` on success; on failure
prints the error message to stderr and exits 1. No vitest — it is run by
`infra/integration/run.sh` inside the Lima VM.

**Tests (`preflight.test.ts`), all with injected fake deps (no real exec/fs):**

- Docker runtime (or unset `EVELAND_RUNTIME`): `assertWorkerPreflight` resolves without
  invoking any dep (assert via spy).
- All checks passing: resolves, `collectSystemdPreflightIssues` returns `[]`.
- Each individual check failing produces an issue mentioning the failing item
  (platform, systemd dir, uid, data dir unset, data dir relative, each missing binary,
  missing user, missing /workspace, backendDistDir throw, traversal failure).
- `bwrap` is not required when `EVELAND_BUILD_SANDBOX=none`.
- Multiple failures are all reported in one thrown error message.
- Traversal probe is skipped when the user does not exist.

## Task 2: Compose topology — explicit runtime, prod overlay

**Files:**

- Edit `docker-compose.yml`
- Edit `docker-compose.prod.yml`

**Changes to `docker-compose.yml`:** add one line to the `worker` service `environment`:

```yaml
EVELAND_RUNTIME: docker
```

so local development is pinned to the Docker runtime regardless of future default
changes (PR 4 flips the production default).

**Changes to `docker-compose.prod.yml`:**

1. `worker` service: add

```yaml
profiles: ["docker-worker"]
```

so the containerized worker no longer starts by default in production. Legacy
Docker-runtime installs opt back in with `--profile docker-worker`. Also add to its
`environment`: `EVELAND_RUNTIME: docker` and `EVELAND_DATA_DIR: /var/lib/eveland`, and
add a volume `- /var/lib/eveland:/var/lib/eveland` so an opted-in legacy worker agrees
with the API's data dir below.

2. `api` service: add to `environment`: `EVELAND_DATA_DIR: /var/lib/eveland`, and add:

```yaml
volumes:
  - .:/workspace
  - /var/lib/eveland:/var/lib/eveland
```

(The base file's `volumes` list for `api` also carries the docker.sock mount; in the
prod overlay the full list must be restated because compose merges `volumes` by
appending — restate `.:/workspace`, keep `/var/run/docker.sock:/var/run/docker.sock`,
and add the new bind. Verify the merged result with
`docker compose -f docker-compose.yml -f docker-compose.prod.yml config` if available;
otherwise reason it out and note it in the report.)

3. Update the header comment block: the production shape is now API/Web/Postgres in
   Compose with the worker running on the host as a systemd service
   (`infra/systemd/eveland-worker.service`, see `docs/deploy/linux.md`); the
   `docker-worker` profile exists for legacy Docker-runtime installs; deployed agent data
   lives under `/var/lib/eveland` on the host, bind-mounted into the API at the same path
   so database `sourcePath` values are valid in both places.

**Verification:** `docker compose -f docker-compose.yml config` and
`docker compose -f docker-compose.yml -f docker-compose.prod.yml config` both parse
(if the docker CLI is unavailable in the sandbox, say so in the report and eyeball the
YAML instead). Confirm `docker compose -f docker-compose.yml -f docker-compose.prod.yml config --services`
does NOT list `worker`, and does list it with `--profile docker-worker`.

## Task 3: Host worker unit files, docs, and Lima preflight verification

**Files:**

- Create `infra/systemd/eveland-worker.service`
- Create `infra/systemd/eveland-worker.env.example`
- Edit `docs/deploy/linux.md`
- Edit `infra/integration/run.sh`

**`infra/systemd/eveland-worker.service`:**

```ini
# Host worker for the eveland systemd runtime. Install:
#   cp infra/systemd/eveland-worker.service /etc/systemd/system/
#   install -d -m 0750 /etc/eveland
#   cp infra/systemd/eveland-worker.env.example /etc/eveland/eveland-worker.env  # then edit
#   systemctl daemon-reload && systemctl enable --now eveland-worker
# Assumes the repo is checked out at /opt/eveland with dependencies installed
# (pnpm install) and @eveland/sandbox-bwrap built. The worker refuses to start
# (preflight) if a host prerequisite is missing — see docs/deploy/linux.md.
[Unit]
Description=eveland worker (systemd runtime)
Wants=network-online.target
After=network-online.target

[Service]
Type=exec
# Root on purpose: the worker drives systemd-run, systemctl and chown. Deployed
# agents themselves run unprivileged (User=eveland-app transient units).
User=root
WorkingDirectory=/opt/eveland
EnvironmentFile=/etc/eveland/eveland-worker.env
ExecStart=/usr/bin/env corepack pnpm --filter @eveland/worker exec tsx src/worker.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**`infra/systemd/eveland-worker.env.example`:** every variable from the worker
configuration table in `docs/deploy/linux.md` that a production host must or commonly
does set, with the production values this topology standardizes on:

```bash
EVELAND_RUNTIME=systemd
NODE_ENV=production
EVELAND_DATA_DIR=/var/lib/eveland
DATABASE_URL=postgres://eveland:eveland@127.0.0.1:5432/eveland
WORKFLOW_POSTGRES_URL=postgres://eveland:eveland@127.0.0.1:5432/eveland
# Must match the API's APP_SECRET_KEY (32 bytes); deploys fail at secret-decrypt time on mismatch.
APP_SECRET_KEY=change-me-to-a-32-byte-secret-00
# Optional overrides (defaults shown):
#EVELAND_APP_USER=eveland-app
#EVELAND_BUILD_SANDBOX=bwrap
#EVELAND_MEMORY_MAX=2G
#EVELAND_CPU_QUOTA=200%
#EVELAND_DEPLOYMENT_PORT=41000
#EVELAND_HEALTH_TIMEOUT_MS=15000
#EVELAND_SANDBOX_CACHE_DIR=/var/lib/eveland/sandbox
```

**`docs/deploy/linux.md`:** add a "Production topology" section near the top (after
"Host prerequisites") describing: API/Web/Postgres via
`docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` (the prod
overlay no longer starts a containerized worker; `--profile docker-worker` restores it
for legacy Docker-runtime installs); the host worker installed from
`infra/systemd/eveland-worker.service` + env example; the shared
`/var/lib/eveland` data dir bind-mounted into the API container at the same path (state
why: stored `sourcePath` must resolve in both). Document the startup preflight: the
worker refuses to start under `EVELAND_RUNTIME=systemd` until Linux+systemd, root,
absolute `EVELAND_DATA_DIR`, `systemd-run`/`systemctl`/`node`/`bwrap`, the app user,
`/workspace`, the built sandbox backend, and app-user traversal of the data dir all
check out, and it reports **all** failures at once. Update the existing
`EVELAND_DATA_DIR` table row's example to `/var/lib/eveland` and
`EVELAND_SANDBOX_CACHE_DIR`'s to `/var/lib/eveland/sandbox`.

**`infra/integration/run.sh`:** in the VM block, after the sandbox-bwrap build and
before the systemd-smoke run, add:

```bash
  EVELAND_RUNTIME=systemd EVELAND_BUILD_SANDBOX=bwrap EVELAND_DATA_DIR=/var/lib/eveland-data \
    corepack pnpm --filter @eveland/worker exec tsx src/integration/preflight-check.ts
```

(uses the VM's existing data dir; asserts the real preflight passes on a
freshly-provisioned host — the PR's completion criterion).

**Verification:** `bash -n infra/integration/run.sh`; `systemd-analyze verify` is not
available on macOS, so eyeball the unit file against systemd.service(5) syntax and say
so in the report.
