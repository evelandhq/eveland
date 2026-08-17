# Deploying eveland on Linux (systemd runtime)

## Host prerequisites

- Linux with systemd (verified on Ubuntu 24.04).
- Node.js 24 (e.g. NodeSource), then install the pinned package-manager shim:

  ```bash
  sudo corepack enable
  sudo corepack install --global pnpm@11.7.0
  ```

- Install the host-owned sandbox toolchain. Ubuntu's base image happens to
  include some of these commands, but they are listed explicitly because the
  worker preflight treats the complete set as a deployment contract:

  ```bash
  sudo apt-get install -y apparmor bash bubblewrap ca-certificates curl docker.io findutils git grep jq python-is-python3 python3 python3-pip ripgrep unzip zstd
  ```

- `bubblewrap` from the distro package (`apt-get install bubblewrap`). Ubuntu's
  packaged bubblewrap ships **no** AppArmor profile, and Ubuntu sets
  `kernel.apparmor_restrict_unprivileged_userns=1` by default, which blocks an
  _unconfined non-root_ process from creating a user namespace (root is unaffected).
  Both the build sandbox (described under "How a deployment runs", which runs
  `bwrap` as the unprivileged build user, not root) and the agent exec sandbox
  (below, which runs as the unprivileged deployment user) are unconfined non-root
  processes creating a user namespace, so both need an AppArmor profile that
  grants `bwrap` the `userns` permission:

  ```
  abi <abi/4.0>,
  include <tunables/global>

  profile bwrap /usr/bin/bwrap flags=(unconfined) {
    userns,

    # Site-specific additions and overrides. See local/README for details.
    include if exists <local/bwrap>
  }
  ```

  Save this as `/etc/apparmor.d/bwrap` and load it with
  `apparmor_parser -r -W /etc/apparmor.d/bwrap` (safe to re-run; it replaces an
  already-loaded profile). A distro whose bubblewrap package ships its own profile,
  or a host with the sysctl disabled, needs none of this.

- `/workspace` must exist on the host as an empty directory before any agent uses
  the bubblewrap sandbox backend: `sudo install -d -m 0755 /workspace`. bwrap binds
  each sandbox session directory onto `/workspace` inside the sandbox but cannot
  create that mountpoint itself, because the sandboxed process's argv bind-mounts
  the host root read-only first. This is unrelated to `ProtectSystem=strict` — it is
  the same role eve's Docker backend fills by baking `/workspace` into its base
  image.
- An artifact-access user and same-named group:
  `useradd --system --user-group --home-dir /var/lib/eveland-app --create-home eveland-app`.
  Each Deployment runs under its own systemd `DynamicUser`; those identities
  use `eveland-app` only as their primary access group for the explicitly
  bound release, cache, and policy paths.
- A second service user for builds: `useradd --system --home-dir /var/lib/eveland-build --create-home eveland-build`.
  Dependency lifecycle scripts (`npm ci`/`npx eve build`) run as this user inside
  the build sandbox, not as the worker's own root user (see the build-trust note
  under "Worker configuration" below).
- The worker process must run as root (it drives `systemd-run`, `systemctl`,
  and `chown`). Run it as a systemd service itself.
- `git`: the worker shells out to `git clone` for `import_source` jobs.

## Production topology

The public `apps/docs` site is not part of this single-box topology. It is
deployed independently to Cloudflare Workers at `https://eveland.ai`; see the
public docs deployment section in the root README. The services below are the
self-hosted control plane and Agent data plane.

- **API, Gateway, Web, Postgres, and OpenTelemetry Collector** run in Docker Compose. The API and Gateway have no Docker
  socket or host-controller privilege. Gateway also has no `/var/lib/eveland` mount, and the
  development Compose stack masks `/workspace/.eveland-data` from it:
  `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`. The
  prod overlay no longer starts a containerized worker (see the header comment
  in `docker-compose.prod.yml`); `--profile docker-worker` restores it for
  legacy Docker-runtime installs that have not migrated to the host worker.
- **The worker** runs on the host as a systemd service, not in a container:
  install `infra/systemd/eveland-worker.service` and configure
  `infra/systemd/eveland-worker.env.example` per the instructions in the unit
  file's own header comment.

Both sides share one data directory, `/var/lib/eveland`: the API container
bind-mounts it at that same absolute path, matching the host worker's
`EVELAND_DATA_DIR`. They have to agree, because a project's stored
`sourcePath` is written by whichever side imports the project and read by
whichever side later serves or deploys it — a mismatched mount would leave
one side unable to find files the other wrote.
The managed Collector publishes its service-authenticated platform receiver on
host loopback ports 4317/4318. Its Agent receiver uses 4327/4328: systemd Agents
reach host loopback port 4328, while each active Docker Deployment gets a
private network containing only its Agent and the Collector and uses
`http://eveland-otel-collector:4328`. Do not publish either receiver on a public
interface. The Docker adapter creates and removes these networks with the
Deployment lifecycle and attaches the configured Collector container under the
fixed alias. The Worker detects a recreated Collector by container identity and
reattaches it to surviving managed networks. A missing Collector degrades telemetry
but never blocks an Agent start or cold activation. The orphan sweep removes managed
networks whose Agent container remains absent after the normal grace period.
Different Agent Deployments therefore cannot resolve or connect to one another
through the telemetry path. The Agent receiver is unauthenticated, so each
Deployment's telemetry is attributed by a Worker-signed credential written into
its `agent-policy.json` and mounted read-only. The private provider carries it on
Agent traces, logs, and metrics. Built-in and the external-destination API proxy
verify it and replace Agent-supplied ownership with the Store-owned Deployment
identity; the proxy removes the credential before remote delivery. systemd
Agents use a distinct `DynamicUser`, hide other users' `/proc` entries, and run
with the shared data root masked. Built-in exports only Agent logs and Worker capacity metrics to the
API's service-authenticated `/internal/otel` endpoint; the API still accepts
standard OTLP/HTTP JSON and protobuf for all three signals. The Worker writes
revisioned Collector configuration below
`/var/lib/eveland/otel`, validates it with the pinned official Collector image,
and restarts only the Collector container when an admin changes an external
destination. Compose mounts only that configuration directory read-only into
the Collector; sources, releases, deployment environments, and the rest of
`/var/lib/eveland` remain unavailable to it. Each exporter has an independent
persistent queue below the Collector volume. External queues send to the API egress proxy, which revalidates
DNS, pins the approved address, disables redirects, and attaches the stored
destination credential. Collector self-metrics stay on its loopback Prometheus
endpoint and go only to external destinations that accept platform metrics.
Agent Deployments are not restarted by an observability settings change.

Each active Docker Deployment consumes one bridge subnet. Docker's built-in
address pools are too small for a long-lived multi-Deployment host, so configure
a non-overlapping pool before starting a Docker-runtime Worker:

```json
{
  "default-address-pools": [{ "base": "10.201.0.0/16", "size": 24 }]
}
```

Merge this into `/etc/docker/daemon.json`, choose a base that does not overlap
the host, VPN, or deployment networks, and restart Docker. The example permits
256 bridge networks. Docker-runtime startup preflight creates and removes one
temporary bridge so address-pool exhaustion is reported before any deployment
job is accepted.
Gateway listens on host port 4080 and is the only process Traefik forwards wildcard Agent
hosts to. Agent processes remain on `127.0.0.1:41xxx`; never add those dynamic ports to
Traefik or firewall rules. Start from `infra/traefik/agents.yml`, replace the example domain,
and keep its `!PathPrefix('/internal')` guard.

Keep the wildcard rule path-transparent. Eve 0.37.1 task-input callbacks and custom MCP
channel paths must reach the same Gateway catch-all as canonical session routes; do not add
path-specific proxy rules that bypass Gateway target selection or cold activation.

## Installing and upgrading Eveland

Stable installations run an exact `vX.Y.Z` tag, not a mutable `main` checkout.
Before starting or upgrading the stack, fetch tags, check out the selected
release, install the frozen lockfile, and apply database migrations:

```bash
git fetch --tags origin
git checkout v0.1.0
pnpm install --frozen-lockfile
pnpm --filter @evelandhq/api db:migrate
```

Worker startup and tenant provisioning apply every pending shared
`@evelandhq/workflow-world` migration before the schema is used. This includes
`0006_event_slots.sql` when upgrading through `0.6.0` and the storage-v2 and
retention-class migrations (`0007`–`0009`) introduced in `0.7.0`. The package's
PostgreSQL advisory lock serializes concurrent migration attempts; new and existing
shared databases follow the same automatic bootstrap path.

The external dispatcher in `@evelandhq/workflow-world@0.8.1` and later is single-instance and
holds a PostgreSQL advisory lock for its lifetime. When first upgrading from an older
dispatcher that did not participate in that lock, stop the old process before starting
the new one. The new generation reclaims stranded worker locks only from active runs'
exact per-run queues, re-enqueues those runs, and starts its Graphile worker pool last;
do not run multiple dispatcher replicas against the same shared database.

The host worker runs as root from its own checkout at `/opt/eveland` (see
`infra/systemd/eveland-worker.service`); apply the same tag and
`pnpm install --frozen-lockfile` there. That is the whole upgrade — there is no
separate sandbox-backend build step.

`@evelandhq/sandbox-bwrap` is the only dependency whose compiled `dist/` is
vendored into every agent Release, but it now ships prebuilt from npm out of its
own repository, pinned by the lockfile. Installing the frozen lockfile therefore
gets the exact backend that tag was tested against.

> This backend used to be a workspace package that had to be rebuilt by hand on
> every upgrade. Skipping that step left a stale `dist/` that preflight
> accepted — it checked only that the backend was _built_, not that it was
> current — so every later Release silently vendored the old backend. That
> failure mode no longer exists: there is nothing local to go stale. If you are
> upgrading from an older release, drop the `pnpm --filter @evelandhq/sandbox-bwrap build`
> step from your runbook.

Set `EVELAND_RELEASE_CHANNEL=stable` and `EVELAND_REVISION` to the output of
`git rev-parse --short=12 HEAD` in both the Compose `.env` and
`/etc/eveland/eveland-worker.env`. Restart API, Gateway, and Web from the
control-plane checkout and the Worker from `/opt/eveland`. An instance
intentionally testing `main` uses `EVELAND_RELEASE_CHANNEL=edge` and its exact
revision instead.

The authenticated Web Settings > About page compares Web and API build
identity; API and Gateway also expose it through their existing public
`/health` responses, and Worker prints it on startup. Do not call an upgrade
complete while those visible components disagree. Rollback by checking out a
previous tag is safe only when that release's database contract is compatible
with all migrations already applied; consult the GitHub Release upgrade and
rollback notes before changing tags. See the full
[release policy and checklist](../releases.md).

Team admins can use the same About page to inspect the allowlisted effective
configuration for Web, API, Gateway, and Worker. Secrets appear only as a fixed
mask, and connection URLs omit credentials, query values, and fragments. This
diagnostic is intentionally absent from public `/health`: API reads Gateway
through its service-authenticated `/internal/diagnostics/config` route, while
Worker writes an already-masked `diagnostics/worker-configuration.json` under
the shared `EVELAND_DATA_DIR` after startup preflight succeeds. The snapshot is
written atomically with mode `0600`; API never reads `/etc/eveland/eveland-worker.env`.
If Worker has not published a snapshot, About reports it as unavailable rather
than guessing values; the observed timestamp identifies older snapshots.

### Startup preflight

When the resolved runtime is Docker, the Worker first proves that Docker can
allocate and release an Agent bridge subnet; failure points to the
`default-address-pools` configuration above. When the resolved runtime is
systemd — an explicit `EVELAND_RUNTIME=systemd`,
or `NODE_ENV=production` with `EVELAND_RUNTIME` unset — the worker refuses to
start until every host
prerequisite checks out (`apps/worker/src/runtime/preflight.ts`): Linux with
systemd, running as root, `EVELAND_DATA_DIR` set to an absolute path,
`systemd-run`, `systemctl`, `runuser`, `docker`, `ss`, and `ps` (the last two
verify that a deployment's loopback port is actually held by its own unit
before the deployment is marked ready), plus the complete platform sandbox
toolchain (`bash`, `node`, `npm`, `pnpm`, `rg`, GNU `grep`/`find`, `git`, `curl`,
`jq`, `python`/`python3`, `pip`/`pip3`, `unzip`, and `zstd`) on `PATH`
unconditionally, plus `bwrap` unless `EVELAND_BUILD_SANDBOX=none`, the app user
(`EVELAND_APP_USER`, default `eveland-app`) and the build user
(`EVELAND_BUILD_USER`, default `eveland-build`) existing, `/workspace` existing
as a directory, `@evelandhq/sandbox-bwrap` being resolvable (`pnpm install`), and
the app user being able to traverse the
data dir. It reports
every failing check at once instead of stopping at the first — the same
one-complete-punch-list approach as the sandbox self-check under "Agent exec
sandbox" below. The backend check is a module resolution — the package ships
prebuilt from npm, so it is either the version the lockfile pins or absent
entirely; the stale-artifact hole that existed when it was built locally is
gone.
`apps/worker/src/integration/preflight-check.ts` runs this same check
standalone and prints `PREFLIGHT OK` on success; `infra/integration/run.sh`
runs it against the Lima VM as part of the integration smoke test.

## Worker configuration

| Env var                                            | Default                                                                                                        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EVELAND_RUNTIME`                                  | `docker`; `systemd` when `NODE_ENV=production`                                                                 | Set `systemd` explicitly on the deploy host. An explicit value always wins over the `NODE_ENV`-based default.                                                                                                                                                                                                                                                                                                                                                                                                |
| `EVELAND_RELEASE_CHANNEL`                          | `dev`                                                                                                          | Product release channel reported by health, logs, and Web About: `dev`, `edge`, `prerelease`, or `stable`. Production tag checkouts use `stable`; `main` test instances use `edge`.                                                                                                                                                                                                                                                                                                                          |
| `EVELAND_REVISION`                                 | `unknown`                                                                                                      | Exact deployed Git revision, normally `git rev-parse --short=12 HEAD`. Configure the same value for API, Gateway, Web, and Worker.                                                                                                                                                                                                                                                                                                                                                                           |
| `EVELAND_APP_USER`                                 | `eveland-app`                                                                                                  | Unix user and same-named access group that own built release/cache artifacts and are granted only on each Deployment's explicitly bound paths. Deployment processes use separate systemd dynamic users.                                                                                                                                                                                                                                                                                                      |
| `EVELAND_BUILD_USER`                               | `eveland-build`                                                                                                | Unix user the build (`npm ci`/`npx eve build`, i.e. third-party lifecycle scripts) runs as.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `EVELAND_MEMORY_MAX`                               | `2G`                                                                                                           | Per-Deployment memory ceiling: systemd `MemoryMax` in production and Docker `--memory` in the local runtime.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EVELAND_CPU_QUOTA`                                | `200%`                                                                                                         | Per-Deployment CPU ceiling: systemd `CPUQuota` in production and Docker `--cpus` in the local runtime.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `EVELAND_TASKS_MAX`                                | `512`                                                                                                          | Per-Deployment process/thread ceiling: systemd `TasksMax` or Docker `--pids-limit`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `EVELAND_SANDBOX_RUN_TIMEOUT_MS`                   | `600000`                                                                                                       | Hard wall-clock limit for one sandbox `run()` command. Timeout kills the complete bwrap process group; authored long-running processes must use `spawn()`.                                                                                                                                                                                                                                                                                                                                                   |
| `EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES`         | `64`                                                                                                           | Maximum live sandbox commands admitted in one compute generation. This bounds bwrap churn before the Deployment-wide Docker/systemd PID ceiling is reached.                                                                                                                                                                                                                                                                                                                                                  |
| `EVELAND_SANDBOX_MAX_OUTPUT_BYTES`                 | `16777216`                                                                                                     | Maximum combined stdout and stderr retained by one sandbox `run()` command. Exceeding it aborts and cleans up the complete process group.                                                                                                                                                                                                                                                                                                                                                                    |
| `EVELAND_BUILD_SANDBOX`                            | `bwrap`                                                                                                        | `none` disables the build sandbox (not recommended: `npm install` runs third-party lifecycle scripts).                                                                                                                                                                                                                                                                                                                                                                                                       |
| `EVELAND_DATA_DIR`                                 | `.eveland-data`                                                                                                | Sources, builds, npm cache, env files, Agent observability policies, and managed Collector configuration. Use an absolute path, e.g. `/var/lib/eveland`.                                                                                                                                                                                                                                                                                                                                                     |
| `EVELAND_HOST_DATA_DIR`                            | `EVELAND_DATA_DIR`                                                                                             | Host-daemon view of the same data directory. Set this only when a containerized worker drives Docker through `/var/run/docker.sock`; native systemd workers use the same path on both sides.                                                                                                                                                                                                                                                                                                                 |
| `EVELAND_OTLP_ENDPOINT`                            | `http://127.0.0.1:4318`                                                                                        | Service-authenticated platform OTLP/HTTP receiver used by API, Gateway, and Worker. Agent receiver endpoints are injected through the runtime policy.                                                                                                                                                                                                                                                                                                                                                        |
| `EVELAND_OTLP_SERVICE_TOKEN`                       | _(unset)_                                                                                                      | Required shared secret for API, Gateway, Worker, and Collector platform traffic plus Collector-to-API observability requests. Agents must not receive it.                                                                                                                                                                                                                                                                                                                                                    |
| `EVELAND_OBSERVABILITY_PRIVATE_ENDPOINT_ALLOWLIST` | _(empty)_                                                                                                      | Comma-separated exact hostnames/IPs permitted to use HTTP or resolve to non-public addresses for external destinations. Keep empty unless a private OTLP target is intentional.                                                                                                                                                                                                                                                                                                                              |
| `EVELAND_OTEL_METRIC_INTERVAL_MS`                  | `60000`                                                                                                        | Platform SDK metric export interval.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `EVELAND_HOST_METRIC_INTERVAL_MS`                  | `60000`                                                                                                        | Worker cadence for standard host CPU, memory, filesystem, workload, and heartbeat metrics.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `EVELAND_OTEL_COLLECTOR_CONTAINER`                 | `eveland-otel-collector`                                                                                       | Collector container restarted after a generated configuration passes validation.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `EVELAND_OTEL_COLLECTOR_IMAGE`                     | `otel/opentelemetry-collector-contrib:0.149.0`                                                                 | Official image used to validate generated configuration; keep it aligned with Compose.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `EVELAND_AGENT_BASE_DOMAINS`                       | `agent.localhost`                                                                                              | Comma-separated Host suffix allowlist used by Gateway; the first value is the canonical domain materialized into routes. Production normally uses one value such as `agents.example.com`.                                                                                                                                                                                                                                                                                                                    |
| `EVELAND_GATEWAY_INTERNAL_URL`                     | `http://127.0.0.1:4080`                                                                                        | Private API/worker control URL for Playground and route-cache invalidation.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `EVELAND_GATEWAY_SERVICE_TOKEN`                    | _(unset)_                                                                                                      | Required shared secret for API/Gateway `/internal/*` calls, including runtime activation; use a long random value and configure it identically on API, worker, and Gateway.                                                                                                                                                                                                                                                                                                                                  |
| `EVELAND_GATEWAY_AFFINITY_SECRET`                  | _(dev fallback only under explicit `NODE_ENV=development`)_                                                    | Required whenever `NODE_ENV` is not explicitly `development` (an unset `NODE_ENV` fails closed). HMAC-signs the HttpOnly affinity cookie; keep it independent from the internal service token.                                                                                                                                                                                                                                                                                                               |
| `EVELAND_GATEWAY_MAX_REQUEST_BODY_BYTES`           | `10485760`                                                                                                     | Maximum buffered public request body accepted before Gateway returns 413 without contacting a deployment.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `EVELAND_MAX_UPLOAD_BYTES`                         | `104857600`                                                                                                    | Maximum zip upload accepted by `POST /projects` and `POST /source-preflights` before the API returns 413. Uploads are buffered in memory, so keep this bounded.                                                                                                                                                                                                                                                                                                                                              |
| `EVELAND_API_INTERNAL_URL`                         | `http://127.0.0.1:4000`                                                                                        | Private API origin used by Gateway for service-authenticated dormant Deployment activation. Compose uses `http://api:4000`.                                                                                                                                                                                                                                                                                                                                                                                  |
| `EVELAND_ACTIVATION_LEASE_TTL_MS`                  | `180000`                                                                                                       | API lease lifetime for public requests, turns, streams, and ScheduleRuns. Keep it longer than the Gateway renewal interval.                                                                                                                                                                                                                                                                                                                                                                                  |
| `EVELAND_PLAYGROUND_SESSION_IDLE_TTL_MS`           | `86400000`                                                                                                     | Playground SessionBinding idle lifetime. Set the same value on API, Gateway, and worker.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `EVELAND_API_SESSION_IDLE_TTL_MS`                  | `604800000`                                                                                                    | Public API SessionBinding idle lifetime. Set the same value on API, Gateway, and worker.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `EVELAND_COLD_START_TIMEOUT_MS`                    | `30000`                                                                                                        | Maximum time Gateway waits for API/Worker to make a dormant Deployment ready before returning 503/504.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `EVELAND_ACTIVATION_RENEW_INTERVAL_MS`             | `60000`                                                                                                        | Gateway renewal interval while an upstream response stream is still active.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `EVELAND_SCHEDULER_RUNTIME_SECRET`                 | _(dev fallback only under explicit `NODE_ENV=development`)_                                                    | Required in production on API and worker. Authenticates the injected private Scheduler Channel and its API callback; keep it independent from Gateway and Better Auth secrets.                                                                                                                                                                                                                                                                                                                               |
| `EVELAND_SCHEDULER_DISPATCH_SECRET`                | _(dev fallback only under explicit `NODE_ENV=development`)_                                                    | Required in production on API and worker. Signs short-lived, single-use credentials bound to one ScheduleRun and Deployment. It is never injected into an Agent.                                                                                                                                                                                                                                                                                                                                             |
| `EVELAND_SCHEDULER_REDEEM_URL`                     | _(unset)_                                                                                                      | API callback injected into prepared Eve Releases. A host systemd runtime normally uses `http://127.0.0.1:4000/internal/scheduler/dispatch`; Docker Agent containers use `http://host.docker.internal:4000/internal/scheduler/dispatch`.                                                                                                                                                                                                                                                                      |
| `EVELAND_SCHEDULER_PLANNER_BATCH_SIZE`             | `25`                                                                                                           | Maximum due schedules atomically claimed in one Worker planner tick.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `EVELAND_SCHEDULER_DISPATCH_TIMEOUT_MS`            | `120000`                                                                                                       | Maximum private Scheduler Channel dispatch duration before the Worker treats the result as failed or unknown.                                                                                                                                                                                                                                                                                                                                                                                                |
| `EVELAND_SCHEDULER_PREWARM_MS`                     | `60000`                                                                                                        | Window before `nextRunAt` in which the scheduler target stays warm or is proactively activated. Prewarming never executes the handler early.                                                                                                                                                                                                                                                                                                                                                                 |
| `EVELAND_SCHEDULE_RUN_MAX_RUNTIME_MS`              | `86400000`                                                                                                     | Hard safety deadline for a dispatched ScheduleRun when private OTLP observations produce no terminal turn boundary. This is independent from the activation idle TTL.                                                                                                                                                                                                                                                                                                                                        |
| `EVELAND_IDENTITY_ISSUER`                          | `http://localhost:4000`                                                                                        | Stable public issuer embedded in Caller Tokens; configure the same value on API and worker.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `EVELAND_IDENTITY_JWKS_URL`                        | issuer + `/.well-known/jwks.json`                                                                              | Agent-reachable signing-key URL reserved and injected by Worker. Host systemd deployments normally use API loopback.                                                                                                                                                                                                                                                                                                                                                                                         |
| `EVELAND_ACTIVATION_IDLE_TTL_MS`                   | `300000`                                                                                                       | Time after the final lease release/expiry before Worker stops a ready RuntimeInstance. The Deployment and Release remain.                                                                                                                                                                                                                                                                                                                                                                                    |
| `EVELAND_ACTIVATION_REAPER_BATCH_SIZE`             | `25`                                                                                                           | Maximum idle RuntimeInstances claimed per Worker tick.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `EVELAND_ACTIVATION_RECOVERY_BATCH_SIZE`           | `25`                                                                                                           | Maximum interrupted `starting` RuntimeInstances re-enqueued per Worker tick.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EVELAND_ACTIVATION_START_STALE_MS`                | `300000`                                                                                                       | Age after which a running activation job can be reclaimed following a Worker crash.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `EVELAND_ACTIVATION_RECONCILE_BATCH_SIZE`          | `100`                                                                                                          | Maximum ready RuntimeInstances compared with Docker/systemd process state per Worker tick.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `EVELAND_ORPHAN_SWEEP_INTERVAL_MS`                 | `3600000`                                                                                                      | Interval between orphan-resource sweeps (1 hour). The Worker lists running `eveland-*-dep_*` units/containers, adopts unmanaged ones into the RuntimeInstance idle lifecycle, stops processes no Deployment legitimately owns, and removes managed Agent telemetry networks whose container remains absent. `0` disables the sweep.                                                                                                                                                                          |
| `EVELAND_ORPHAN_GRACE_MS`                          | `300000`                                                                                                       | How long an out-of-model process may keep running before the sweep stops it.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EVELAND_RELEASE_SWEEP_INTERVAL_MS`                | `3600000`                                                                                                      | Interval between automatic Release retention sweeps (1 hour). Each sweep enqueues archive jobs for old, unprotected, stopped Deployments; `0` disables the sweep.                                                                                                                                                                                                                                                                                                                                            |
| `EVELAND_RELEASE_SWEEP_BATCH_SIZE`                 | `25`                                                                                                           | Maximum new archive jobs enqueued by one Release retention sweep.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `EVELAND_DEPLOYMENT_PORT`                          | `41000`                                                                                                        | Start of the host-port allocation range. The worker scans `startPort..startPort+100` for a free `127.0.0.1` port to bind each deployment to.                                                                                                                                                                                                                                                                                                                                                                 |
| `EVELAND_GIT_CLONE_TIMEOUT_MS`                     | `120000`                                                                                                       | Maximum non-interactive Git clone duration before an import fails and its partial source directory is removed. Increase this only when the worker's network requires a longer bounded transfer window.                                                                                                                                                                                                                                                                                                       |
| `EVELAND_GIT_CLONE_MAX_ATTEMPTS`                   | `3`                                                                                                            | Maximum attempts for transient Git network failures; authentication and repository-not-found failures are not retried.                                                                                                                                                                                                                                                                                                                                                                                       |
| `EVELAND_GIT_CLONE_RETRY_DELAY_MS`                 | `1000`                                                                                                         | Initial exponential backoff delay between Git attempts.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `EVELAND_SOURCE_PREFLIGHT_TTL_MS`                  | `3600000`                                                                                                      | Lifetime of an unconsumed source check. The worker removes expired managed snapshots; running checks are never expired mid-scan.                                                                                                                                                                                                                                                                                                                                                                             |
| `WORKER_JOB_HEARTBEAT_INTERVAL_MS`                 | `30000`                                                                                                        | How often a running job renews its lease.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `WORKER_JOB_STALE_MS`                              | `120000`                                                                                                       | Time without a heartbeat before a running job is re-queued after worker failure. Keep this above the heartbeat interval.                                                                                                                                                                                                                                                                                                                                                                                     |
| `WORKER_JOB_RECOVERY_BATCH_SIZE`                   | `25`                                                                                                           | Maximum stale jobs recovered per worker poll.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `EVELAND_HEALTH_TIMEOUT_MS`                        | `15000`                                                                                                        | How long the worker polls the deployment's HTTP health endpoint before failing the deploy.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `EVELAND_HOST_METRIC_INTERVAL_MS`                  | `60000`                                                                                                        | How often Worker emits host CPU, memory, load, data-filesystem, inode, workload, and heartbeat metrics through OTLP.                                                                                                                                                                                                                                                                                                                                                                                         |
| `EVELAND_RELEASE_RETENTION`                        | `3`                                                                                                            | Minimum number of newest release artifacts protected from automatic or manual archive. Mutable route targets, non-expired SessionBindings, and active request leases are protected independently of age. Older unprotected stopped Deployments are swept automatically; archive removes both the runtime artifact and build directory.                                                                                                                                                                       |
| `APP_SECRET_KEY`                                   | _(hardcoded dev key)_                                                                                          | Required in production. Decrypts stored secrets and derives Agent telemetry credentials. It must match the API value. After rotation, redeploy every Agent Deployment so its policy contains a credential signed by the new key; hot reload across a key change is not supported. Never rely on the fallback dev key outside local development.                                                                                                                                                              |
| `WORKFLOW_POSTGRES_URL`                            | _(unset)_                                                                                                      | Platform-owned Postgres **base** URL for durable workflow worlds. The worker derives one database per project (`eveland_wf_<project>_<digest>`), creates and bootstraps it before any deployment process starts, and injects the derived URL — same-Project deployments share one workflow. The role in this URL needs `CREATEDB`. Required in production and reserved from Project Secret overrides. For systemd, use a host-reachable address such as `postgres://eveland:eveland@127.0.0.1:5432/eveland`. |
| `WORKFLOW_POSTGRES_BOOTSTRAP_URL`                  | Matching `DATABASE_URL` when the deployment URL uses `host.docker.internal`; otherwise `WORKFLOW_POSTGRES_URL` | Optional worker-reachable address for the same database. Set this when deployed Docker Agents require `host.docker.internal` but the worker reaches a separate workflow database through `localhost` or a Compose service name. It is never injected into an Agent.                                                                                                                                                                                                                                          |
| `WORKFLOW_POSTGRES_MAX_POOL_SIZE`                  | `10`                                                                                                           | Max pg pool connections each deployment runtime opens against its workflow database; the worker injects it into every deployment and Project Secrets cannot override it. Size the workflow instance's `max_connections` as roughly this value × expected concurrent running deployments, plus the control-plane pools when both share one Postgres instance. Lower it to fit more deployments per instance; a Postgres `FATAL 53300 "too many clients"` at deployment startup means this budget is exceeded. |
| `EVELAND_WORKFLOW_WORLD_URL`                       | _(unset)_                                                                                                      | Deployment-reachable shared database for `@evelandhq/workflow-world`. Required before selecting projects with `EVELAND_WORKFLOW_WORLD_ROLLOUT`; leave unset to keep the legacy topology only.                                                                                                                                                                                                                                                                                                                |
| `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL`             | `EVELAND_WORKFLOW_WORLD_URL`                                                                                   | Host-reachable address for the same shared database. Worker startup and tenant provisioning use it to apply all pending migrations automatically.                                                                                                                                                                                                                                                                                                                                                            |
| `EVELAND_WORKFLOW_STREAM_COMPACTION`               | `on`                                                                                                           | Reserved switch injected into shared-world Deployments and also set on the dispatcher. `off` disables new snapshot stripping and terminal block rewrite compaction only; readers remain mixed-format compatible.                                                                                                                                                                                                                                                                                             |
| `EVELAND_WORKFLOW_SWEEP_INTERVAL_MS`               | `3600000`                                                                                                      | Legacy per-project stream-retention cadence; `0` disables that legacy sweep. Shared-world maintenance belongs to the dispatcher.                                                                                                                                                                                                                                                                                                                                                                             |
| `EVELAND_WORKFLOW_STREAM_RETENTION_MS`             | `86400000`                                                                                                     | Legacy terminal stream replay window: 24 hours. EOF markers are not deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EVELAND_WORKFLOW_SWEEP_BATCH_SIZE`                | `50000`                                                                                                        | Maximum rows per legacy retention `DELETE` statement.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `NODE_ENV`                                         | _(unset)_                                                                                                      | Set `production` on the deploy host to require the platform durable world; the worker fails before accepting jobs if `WORKFLOW_POSTGRES_URL` is absent. Also injected into each deployment so the Agent runs in production mode. `production` additionally makes the runtime default to `systemd` when `EVELAND_RUNTIME` is unset (see the `EVELAND_RUNTIME` row above).                                                                                                                                     |
| `EVELAND_SANDBOX_CACHE_DIR`                        | `$EVELAND_DATA_DIR/sandbox`                                                                                    | Root holding every project's durable eve sandbox session cache (bubblewrap templates and session workspaces), one subdirectory per project. Use an absolute path, e.g. `/var/lib/eveland/sandbox`. Lives outside every release directory on purpose — see "Agent exec sandbox" below.                                                                                                                                                                                                                        |

Eve 0.37.1 durable Gateway routes also use these existing controls. The affinity secret derives
non-reversible create-once operation keys; their trigger-specific idle TTL matches SessionBindings,
and active OperationBindings protect the exact Deployment from Release retention. Deployments of one
Project intentionally share its workflow world (different Projects remain isolated), which lets an
opaque task-input callback resume through any compatible target.

### Playground authentication credential boundary

Playground route-auth credentials are not control-plane cookies and are not Gateway configuration.
API owns the encrypted Playground authentication config and uses `APP_SECRET_KEY` to open it for a single request.
It then sends a versioned credential envelope over the existing private `/internal/projects/:projectId/playground/eve/*`
path. Gateway accepts that envelope only after `EVELAND_GATEWAY_SERVICE_TOKEN` succeeds, validates its authority
and Header policy, applies the credential last, and never persists it.

Keep `/internal/*` excluded from every public Traefik route. A missing envelope currently retains the
service-authenticated loopback behavior for rolling-upgrade compatibility, but current API instances always send an
explicit envelope. `local-dev` is the only method that selects loopback authority; `none`, Basic, Bearer, Vercel
OIDC, generic OIDC, and custom headers use the canonical Project hostname so Eve cannot mistake a public-style request for local development.
Changing a normalized Playground authentication method/config increments its security revision; unchanged re-saves do not.
Playground authentication password, token, and custom Header values must never be copied into Compose files, systemd env files,
runtime diagnostics, logs, Source Revisions, Releases, OTLP signals, or browser payloads.

For generic OIDC, register `${WEB_ORIGIN}/agent-auth/oidc/callback` as an exact redirect URI. The callback page is
owned by Web and completes through the authenticated API; API encrypts one-time ten-minute transactions and
principal-scoped access/refresh tokens with `APP_SECRET_KEY`. A confidential client's Playground authentication config stores only a
Project Secret reference, so create that Secret before saving a `client_secret_basic` or `client_secret_post`
method. API resolves the current referenced value
again for preflight, callback, verification, and refresh; rotating the Secret does not copy it into Playground authentication config.

Production network policy must allow API egress only to approved OIDC discovery, authorization metadata, JWKS,
token, and UserInfo HTTPS endpoints. Application URL policy rejects userinfo/fragments, non-HTTPS endpoints,
localhost, literal private addresses, and redirects; the network layer must additionally prevent DNS rebinding and
resolved private/link-local destinations. Never expose OIDC tokens, authorization codes, state, client secrets, or
PKCE verifiers through reverse-proxy access logs or runtime diagnostics.

The explicit Vercel OIDC Playground authentication method mirrors Eve 0.29.5 by resolving its configured Secret reference and
sending the token in both `Authorization: Bearer` and `x-vercel-trusted-oidc-idp-token`. Vercel OIDC tokens are short
lived; rotate the referenced Secret before expiry. Eveland does not infer this method from a Vercel deployment,
Agent source, or a 401 response.

External authenticated chat uses a separate managed Identity boundary. Set the same stable public
`EVELAND_IDENTITY_ISSUER` on API and worker, set `EVELAND_IDENTITY_ALLOWED_ORIGINS` to the exact
EveChats browser origin, and give the worker an Agent-reachable `EVELAND_IDENTITY_JWKS_URL`
(`http://127.0.0.1:4000/.well-known/jwks.json` for host systemd Agents). In System > Identity,
create the Internal Provider and exact allowed Realm, register the `eve-chats` return origin, and
verify the read-only `/agent-catalog` projection. The Catalog returns the same routable
`eveChannel` Projects to every caller; it is public, does not filter by Realm, and does not
configure Agent authorization. The worker reserves and injects issuer, JWKS URL, and
`EVELAND_PROJECT_ID`; Project Secrets and Shared Agent Environment cannot override them.

Do not reuse `BETTER_AUTH_SECRET`, Better Auth cookies, Playground authentication credentials, or
provider tokens in EveChats or Agent configuration. When an Agent's route auth requires
Eveland Identity, its `WWW-Authenticate` response identifies the Eveland login continuation and
Project audience. The browser follows that continuation, obtains a short-lived Caller Token, and
retries the original request. Gateway transparently forwards both the challenge and credential;
the Agent verifies the token and remains responsible for business authorization, including `403`.

Deploy Eveland Identity and the browser chat surface on the same schemeful site,
typically as sibling HTTPS subdomains. The separate `eveland_identity` cookie is
scoped to `/identity` and protects only the Identity API; `/agent-catalog` is public.
The cookie uses `SameSite=Lax`, so an unrelated site cannot use it for credentialed
token requests even when its exact origin is present in the CORS allowlist.

Project stable routes use `<projectSlug>.<baseDomain>`. Immutable Deployment previews use
`<eightCharacterDeploymentKey>--<projectSlug>.<baseDomain>`; the separator stays inside one
DNS label so a single `*.agents.example.com` wildcard certificate covers both forms. Project
slugs are globally unique and immutable. Deployment keys contain exactly eight lowercase
letters or digits and are unique within their Project; full `proj_*` and `dep_*` IDs remain
internal control-plane identities.

Project Secret mutations are applied asynchronously because only the worker owns
runtime-controller privilege. Saving, replacing, or deleting a Secret queues one
targeted `restart_deployment` job for every `running` or `draining` Deployment,
including stable, preview, and A/B targets. Each restart reuses the immutable Release
and rebuilds the process environment from the current encrypted Secret set. Wait for
those jobs to complete before testing the new value; a single-target route can be
briefly unavailable while its process restarts.

The singleton Shared Agent Environment is stored in Postgres as AES-256-GCM ciphertext
using the same `APP_SECRET_KEY`; it does not add another host environment variable or
Compose secret. Only admins can change it, and it applies automatically to every Agent
Deployment. At process start the worker resolves Shared Agent Environment < Project Secret
< Eveland-reserved precedence, writes the final values only to the Docker process
environment or the systemd adapter's root-owned `0600` `EnvironmentFile`, and adds every
decrypted shared value to runtime/build diagnostic masking. Values never enter a Release,
build layer, OTLP signal, API response, Web payload, or worker configuration snapshot.

Changing or clearing the shared environment queues `restart_deployment` jobs for every
`running`/`draining` Deployment so an old process cannot retain stale or deleted values.
With no live target, the next deploy, restart, cold activation, or schedule activation reads
the latest revision. Playground authentication credentials are separate and new configuration uses
Project Secret references resolved per request. There are no named Profile, runtime binding,
or Platform Secret reference compatibility paths. API/worker `APP_SECRET_KEY` values must
continue to match; worker preflight and Compose
topology otherwise require no new setting.

GitLab PAT imports use the same `APP_SECRET_KEY` on API and worker. The database stores only
AES-256-GCM ciphertext keyed by user and normalized HTTP host. During `git clone`, the worker
passes a host-scoped Basic authorization header through Git's temporary environment config;
the token is not embedded in argv, the repository URL, `.git/config`, job/status responses,
or logs. The credential is promoted to the user's saved settings only after a complete source
import succeeds. Operators should require PAT expiry and the minimal `read_repository` scope,
and can revoke a compromised token in GitLab plus remove its host entry in Settings. SSH/SCP
imports continue to use the worker host's existing SSH configuration and do not consume PATs.

Build-trust note: building a project executes that project's dependency
lifecycle scripts (`pnpm install`/`npm ci`/`npm install`, e.g. `postinstall`) inside the build
sandbox as the unprivileged build user (`EVELAND_BUILD_USER`, default
`eveland-build`), not as root. Imported projects — and their full dependency
trees — are trusted only up to that sandbox's boundary (see
`EVELAND_BUILD_SANDBOX` above and the warning below): nothing outside
`releaseDir` and the npm cache is writable, and the eveland data dir (other
projects' builds, sources, and decrypted secret env files) is hidden entirely
— the bwrap mask applies regardless of which user is inside it. The rest of
the host filesystem remains read-only visible to the build, which still has
network access, but because the build no longer runs as root, its lifecycle
scripts also lose root's read access to that read-only host filesystem.

Worker secrets are hidden entirely too, but not by the filesystem mask above:
the worker process's own environment (`APP_SECRET_KEY`, `DATABASE_URL`,
`WORKFLOW_POSTGRES_URL`, and anything else on its `process.env`) would
otherwise be inherited by the build subprocess and readable by lifecycle
scripts via `/proc/self/environ`, regardless of the unprivileged build user or
the bwrap mask. Both build modes (`bwrap` and `none`) instead build the
subprocess's environment from a fixed allowlist — `PATH` and `npm_config_cache`
— rather than inheriting the worker's own environment, so no worker secret
ever reaches the build. `HOME` is not part of that allowlist: `runuser`
(without `-m`/`--preserve-environment`) resets `HOME`, `SHELL`, `USER` and
`LOGNAME` to the build user's own passwd entry as part of the user switch, so
an execa-supplied `HOME` would just be discarded — it is instead injected
_after_ the switch, pointed at the release directory, via bwrap's own
`--setenv HOME` in `bwrap` mode or an `env HOME=...` wrapper in `none` mode.
The allowlist also deliberately drops operator proxy configuration
(`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`, `npm_config_registry`): a build on a
host that requires a proxy to reach the npm registry needs a mirror reachable
without env-borne proxy config today; passing those through under an explicit
opt-in is possible future work.

The project's own Agent environment joins that allowlist, but only its
`variable` entries — never a `secret`, from either the Project's environment or
the Shared Agent Environment. `npx eve build` imports the project's agent
config to compile the Release manifest, so a config that resolves its model id
(or any other compile-time value) from `process.env` would otherwise compile
its authored fallback and freeze that stale value into every turn the Release
reports. A `variable` is operator-declared non-secret configuration, so it can
cross into a boundary where untrusted lifecycle scripts can read it; a `secret`
cannot, and reaches the deployed process only.

Two groups of names stay platform-owned, and an entry claiming either is
dropped from the build with a `WARNING` in the build log — never silently:

- **`PATH`, `HOME`, `NPM_CONFIG_CACHE`** — the build's own toolchain.
  `NPM_CONFIG_CACHE` because npm reads it case-insensitively alongside
  `npm_config_cache`, so an entry using it could redirect the shared cache out
  of the platform's directory. These still reach the deployed process normally.
- **Every name the platform reserves at runtime** — `NODE_ENV`,
  `EVELAND_PROJECT_ID`, `EVELAND_IDENTITY_ISSUER`, `EVELAND_IDENTITY_JWKS_URL`,
  `EVELAND_SCHEDULER_REDEEM_URL`, `EVELAND_SCHEDULER_RUNTIME_SECRET`,
  `WORKFLOW_POSTGRES_URL`, `WORKFLOW_POSTGRES_MAX_POOL_SIZE`. The runtime
  applies these last, so a build that adopted the project's value would compile
  against something the deployed process then overrides — the same
  build/runtime divergence build-visible variables exist to close. `NODE_ENV`
  is dropped from every build regardless of the host's own `NODE_ENV`: `npm ci`
  and `pnpm install --frozen-lockfile` both omit devDependencies when
  `NODE_ENV=production` is set, which would strip the project's own build
  toolchain out of the tree `npx eve build` then compiles against.

Because a Release is immutable, changing a variable refreshes the compiled
manifest only on the next deploy — an environment change alone just restarts
live Deployments onto their existing Release. On the Docker runtime the same
variables are declared as `ARG` in the generated Dockerfile and passed with
`--build-arg`, so their values appear in that image's build metadata. Those
`ARG`s are declared after the dependency-install layer, so on Docker only
`npx eve build` sees them, while the systemd runtime runs install and build in
one shell and exposes them to both.

> **WARNING: never switch `EVELAND_RUNTIME` on a host with live deployments.**
>
> Every deployment record stores the `runtimeKind` (`docker` or `systemd`) of
> the adapter that created it, and stop, restart, and delete always resolve
> their adapter from that recorded value — never from the worker's current
> `EVELAND_RUNTIME`. The remaining risk is a `runtimeKind` that is wrong for
> the process that actually exists: the migration that introduced the column
> backfilled every pre-existing row as `docker`, so a host that already ran
> `EVELAND_RUNTIME=systemd` before upgrading has all of its older deployments
> mislabeled. Stopping one of them then resolves the Docker adapter against a
> systemd unit — the old process is never stopped and keeps its port, a
> redeploy crash-loops or quietly leaves two versions running, and health
> checks can false-pass against the stale process.
>
> Treat the **resolved** runtime as fixed per host, chosen at provisioning
> time — and remember it can change two ways: flipping `EVELAND_RUNTIME`, or
> setting `NODE_ENV=production` on a host that leaves `EVELAND_RUNTIME` unset
> (the production default is `systemd`). The preflight catches an accidental
> flip loudly, but drain first regardless: stop and remove **every**
> deployment before switching the resolved runtime, and before applying the
> `runtimeKind` backfill migration on a host that is not already `docker`:
>
> ```bash
> # systemd host being migrated away from, or upgrading across this migration:
> systemctl stop 'eveland-*'
> systemctl reset-failed 'eveland-*'
>
> # docker host being migrated away from:
> docker rm -f $(docker ps -aq --filter "name=eveland-")
> ```
>
> Only start the worker (with the new `EVELAND_RUNTIME`, if changing it) once
> the old runtime has zero `eveland-*` processes left.

### Deleting a project

`DELETE /projects/:projectId` is asynchronous: like `build-deploy`,
`sync-source`, and `restart`, it enqueues a job — `delete_project` — and
returns `202` immediately instead of deleting inline. The request atomically
persists `deletion_status = 'deleting'`; Web keeps the Project visible as
`Deleting…`, while mutating control-plane requests return `409` until deletion
finishes. The worker does not claim the deletion job while another job for the
same Project is still running.

The job stops every `running` or `draining` Deployment first, resolving each
adapter from the Deployment's recorded `runtimeKind`, then removes its runtime
Release and the Project's platform-managed source, build, Agent observability policy, and
sandbox directories. Only paths contained by `EVELAND_DATA_DIR` are eligible;
an externally supplied source path is never recursively removed. Database
records are deleted last. If a stop, Release removal, filesystem cleanup, or
database operation fails, the Project remains with `deletion_status = 'failed'`
and the error is visible for retry. Because runtime/filesystem cleanup is not a
Postgres transaction, some resources may already have been removed before a
retry.

## Durable workflow world

The Agent does not configure or depend on the durable world. Eveland owns the
complete production boundary:

- `WORKFLOW_POSTGRES_URL` is required when `NODE_ENV=production`; the worker
  fails at startup and a deploy also retains a defensive gate if it is absent.
- Worker startup validates that `WORKFLOW_POSTGRES_URL` is configured in
  production but does not install a workflow schema in that base database. Eve
  0.38.3 requires workflow spec v6, so Releases inject
  `@workflow/world-postgres@5.0.0-beta.34` on the legacy path and
  `@evelandhq/workflow-world@0.9.0` on the shared path. Use
  `WORKFLOW_POSTGRES_BOOTSTRAP_URL` only when the worker needs another address
  for the same database server while administering derived project databases.
  A deployment URL on `host.docker.internal` automatically reuses
  `DATABASE_URL` when its credentials, port, database name, and options
  otherwise match.
- Before any deployment process starts, the worker derives that project's
  workflow database (`eveland_wf_<project>_<digest>`) from the base URL,
  creates it if missing, and bootstraps its schema for the legacy
  `@workflow/world-postgres` path. When `EVELAND_WORKFLOW_WORLD_ROLLOUT` selects
  `@evelandhq/workflow-world`, the worker instead provisions that project's
  partitions in the configured shared database; tenancy and cold-start recovery
  remain scoped by `tenant_id`.
- Worker startup applies all pending shared-World migrations before the dispatcher or
  a Deployment may use the schema; tenant provisioning follows the same path. Set
  `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL` when the host reaches the database through a
  different address than deployments.
- Release preparation copies the imported source, moves any authored root
  `agent.*` config to a reserved sibling inside the copy, and generates a thin
  `agent.ts` wrapper that preserves the authored config while forcing
  `experimental.workflow.world = "@workflow/world-postgres"`.
- Docker and systemd builds select pnpm frozen install for `pnpm-lock.yaml`, npm
  `ci` for `package-lock.json`, and npm `install` only when no lock exists. A
  committed pnpm lock remains frozen and integrity-checked, while the platform's
  own package minimum-release-age policy is disabled for that already-locked graph.
- Builds install the pinned world package through the selected package manager
  before Eve discovery/build; npm uses `--no-save --package-lock=false --ignore-scripts`,
  while pnpm temporarily adds it with lockfile writes disabled and restores the
  manifest on shell exit. The imported source, `package.json`, and lockfile remain unchanged.
- `WORKFLOW_POSTGRES_URL` is a reserved runtime value. A Project Secret with
  that name remains stored and its decrypted value is still log-masked, but it
  cannot redirect the platform world.
- Legacy stream retention runs once at worker startup and hourly by default, preserving
  24 hours of terminal-run chunks and every EOF marker. Shared 0.7 storage strips
  reconstructible snapshots, writes bounded physical blocks/checkpoints, and lets the
  dispatcher run failure-isolated block packing plus deadline-driven stream/run expiry
  at startup and every minute. The `WORKFLOW_DISPATCHER_MAINTENANCE_*` variables bound
  each pass; normal deletes make pages reusable but do not guarantee immediate
  filesystem shrinkage.

When `NODE_ENV` is not production and no workflow URL is configured, Eveland
does not inject a world and Eve keeps its local development world.

## How a deployment runs

- Build: source is copied to `$EVELAND_DATA_DIR/builds/<project>/<release>`, then
  Eveland injects its reserved private OpenTelemetry hook and, when configured, the platform workflow-world
  wrapper into the copied release (never the imported source). The project install and pinned
  package-manager-aware world install run first. When the source declares an Extension mount,
  `eve info` then resolves its distribution and a self-contained integrator adapts schedules and
  directory-form subagents; releases without mounts skip this prepass and do not carry the integrator.
  The final `npx eve build` plus `eve info` compile and record that exact tree, and the build fails if
  the required final scheduler definitions are absent or invalid. These commands run
  as the unprivileged build user (`EVELAND_BUILD_USER`)
  inside bubblewrap (read-only rootfs, writable release dir + shared npm cache,
  PID namespace).
- Run: `systemd-run` starts transient unit `eveland-<project>-<deployment>.service`
  with a deterministic per-Deployment `User=eveland-d-…`, `DynamicUser=yes`,
  `Group=eveland-app`, `UMask=0002`, `ProtectProc=invisible`,
  `ProtectSystem=strict`,
  `ReadWritePaths=<releaseDir>`, `ReadWritePaths=<sandboxCacheDir>`, and a read-only bind of the
  Deployment's Agent observability policy at the fixed runtime path. The fixed
  primary group and group-write umask keep new files group-accessible. A root-only
  UID marker in the Deployment policy records the last dynamic identity; an
  `ExecStartPre` repairs group access for the release and sandbox cache in one
  recursive pass only when that identity changes, so explicit `0600`/`0700`
  entries remain usable without charging every cold activation for a full walk.
  The unit also uses
  `PrivateTmp`, `NoNewPrivileges`,
  `MemoryMax`, `CPUQuota`, `Restart=on-failure`. The app binds `127.0.0.1:<hostPort>`;
  secrets arrive via a root-owned 0600 `EnvironmentFile`.
- Health: the worker polls `http://127.0.0.1:<hostPort>/eve/v1/health` until any
  HTTP response arrives. If the deadline expires, it captures unit state plus
  the final 200 journal lines, masks Project Secret values, persists a bounded
  diagnostic, and only then stops and resets the transient unit. Diagnostic or
  cleanup failures never replace the original health-check error.
- Idle: a Deployment may retain its immutable Release, preview route, and
  SessionBindings while no transient unit exists. Cron or Gateway asks API for
  an ActivationLease; API coalesces `ensure_deployment_running`, Worker starts
  the exact Release with the Deployment's recorded `runtimeKind`, and the final
  lease starts the configured idle deadline. If the imported source directory
  has already been reclaimed, cold and schedule activation recover the package
  manager selection from the immutable SourceRevision's persisted
  `package.json` and lockfile metadata. An explicit restart remains
  live-source-only and fails before stopping the current process when that
  directory is missing. Reaping stops only the process.

## Agent exec sandbox

On the supported systemd deployment host, eve agents get no Docker daemon and no KVM, so eve's default sandbox chain
degrades to the `just-bash` interpreter (no real binaries). eve projects do not opt into
a real exec sandbox themselves: for every deployed project (all of which are eve projects —
the import gate rejects anything else), Eveland's shared release-preparation step generates a sandbox
module — `agent/sandbox.js` for a flat agent, or `agent/sandbox/sandbox.js` when the agent
has a sandbox folder, with one more for every subagent directory however deeply nested —
into the release directory, and vendors this build's `@evelandhq/sandbox-bwrap`
to `<releaseDir>/.eveland/sandbox-bwrap/`. The generated module reads
`EVELAND_SANDBOX_CACHE_DIR` from the environment and passes it to the backend as
`cacheDir`. The runtime also supplies an internal `EVELAND_SANDBOX_TEMPLATE_REVISION`
derived from the immutable Release reference. Nothing in the project's own source tree
is touched to select the backend. Projects may still author Sandbox lifecycle and metadata.

If the project shipped its own `agent/sandbox.ts` or `agent/sandbox/sandbox.ts`, the build
renames that definition to a non-discoverable same-directory companion and writes the generated
module in its place. The generated module spreads the authored definition and then replaces only
`backend`, so `bootstrap()`, `onSession()`, `description`, and `revalidationKey` remain active
while Eveland still owns the deployment backend. Keeping the companion in the same directory
preserves relative imports from the authored module.
An `agent/sandbox/workspace/**` seed tree is preserved in the prepared Release; Eve compiles
those files and initializes them under `/workspace/**` for each new Session. Templates are
revision-scoped, so Sessions created against a later Deployment use its updated seed content.
Existing durable Sessions remain keyed only by Eve's session key and keep their current
workspace files; deployment never overwrites their runtime state.
The build log carries a line so this is never a silent surprise:

```
Preserved the project's authored sandbox lifecycle (agent/sandbox/sandbox.ts). Eveland overrides only the backend; authored bootstrap(), onSession(), description, and revalidationKey remain active, while workspace seeds are preserved.
```

If an eve project has no `agent/` directory at all, injection generates nothing, the
build does not fail, and the log instead warns that the deployed agent falls back to
eve's default sandbox chain:

```
Injected eve sandbox modules: none
WARNING: no agent/ directory was found at the project root, so no sandbox module could be injected. The deployed agent will fall back to eve's default sandbox backend chain.
```

Otherwise a successful build logs which modules were generated, for example:

```
Injected eve sandbox modules: agent/sandbox.js
```

The local Docker runtime uses the same generated module and vendored backend. Its
generated Agent image installs `bubblewrap` plus the same platform sandbox toolchain
listed under "Host prerequisites" and creates `/workspace`. Alpine's BusyBox
`grep`/`find` are deliberately replaced by GNU implementations, while `ripgrep`
serves Eve's preferred `grep` and `glob` paths. At start, the outer Agent container
drops Docker's default capability set, adds only
`SYS_ADMIN` and `NET_ADMIN` for bwrap's mount/network namespaces, sets
`no-new-privileges`, and relaxes the outer seccomp profile. It does **not** receive the
Docker socket, source tree, or another Project's sandbox cache. The worker maps the
Project cache through `EVELAND_HOST_DATA_DIR` and mounts it inside the Agent container
at `/var/lib/eveland-sandbox`. These outer-container settings are deliberately limited
to the local-development Docker runtime; production uses the unprivileged systemd path.
Docker Deployments also start with `--init`: the tiny PID 1 acts as a child subreaper, so
orphaned bwrap descendants are reaped instead of accumulating as zombies until
`--pids-limit` is exhausted. Existing containers acquire this only when they are recreated.
The systemd path needs no equivalent flag: systemd is already the host PID 1/subreaper and
reaps orphaned descendants while `TasksMax` supplies the cgroup process ceiling.

The host prerequisites are the AppArmor profile and the `/workspace` directory
covered above ("Host prerequisites"). The backend works inside the deployment
unit's hardening (`NoNewPrivileges`, `ProtectSystem=strict`) because apt's `bwrap`
is not setuid — it needs no privilege escalation, only the AppArmor grant to create
a user namespace as the unprivileged deployment user. Sandboxed commands never see
the deployment's environment variables (secrets stay in the agent process).

**A build fails when the sandbox does not work under its real runtime permissions, and this is deliberate.**
eve prewarms sandboxes lazily: `eve build` never calls the backend's `prewarm`, so a
completely broken bubblewrap setup (missing AppArmor profile, missing `/workspace`)
does not fail the build, does not fail `eve start`, and does not fail
`/eve/v1/health` — that endpoint returns `200` regardless of sandbox health. Left
unchecked, the first sign of trouble would be a failed agent turn once a user's session
actually touches the sandbox, long after the deploy was reported successful. eveland
closes that gap with a runtime-specific self-check immediately after the build. The
probe runs the real vendored backend — prewarm, create, write a typed `.ts` file, execute
it with Node 24, verify every platform-owned command, exercise an actual `rg` search and
the GNU `grep -r --exclude-dir=.git` fallback that Eve uses, then shutdown — rather than
checking only a shell builtin or `command -v`. On systemd it
runs against a scratch app root under the Project cache as the unprivileged deployment
user with `NoNewPrivileges=yes`, `ProtectSystem=strict`, and `PrivateTmp=yes`. On Docker
it starts the newly built image with the exact capability/seccomp settings the real
Deployment receives and an ephemeral probe cache. The script prints `SANDBOX VERIFY OK`
on success. A passing systemd build logs:

```
Sandbox self-check passed: the vendored bwrap backend runs under this host's deployment hardening.
```

A passing local Docker build logs:

```
Docker sandbox self-check passed: bwrap executed TypeScript with deployment-equivalent permissions.
```

When the check fails — for any reason, including a script that exits 0 without printing
its success marker — the build itself fails. A systemd failure names the sandbox and
toolchain host prerequisites documented above:

```
Sandbox self-check failed: the vendored bwrap backend could not run under this host's deployment hardening. Check these host prerequisites:
  1. /etc/apparmor.d/bwrap must exist and grant `userns`. Ubuntu's apt bubblewrap ships no AppArmor profile, and kernel.apparmor_restrict_unprivileged_userns=1 then blocks non-root bwrap with "setting up uid map: Permission denied".
  2. /workspace must already exist as an empty directory. bwrap cannot create that bind destination itself because the host root is bind-mounted read-only first.
  3. The platform-owned sandbox toolchain must be installed on the host: bash, node, npm, pnpm, rg, grep, find, git, curl, jq, python, python3, pip, pip3, unzip, zstd. The worker preflight reports every missing command.
Captured output (exit=<code>):
<systemd-run output>
```

A Docker failure reports the image probe output and asks the operator to verify that the
local engine supports `SYS_ADMIN`, `NET_ADMIN`, and `seccomp=unconfined`; installing
`just-bash` alone is not a substitute because it cannot execute Node or TypeScript.

Say it plainly: a passing HTTP health check does not by itself mean the sandbox works —
that is precisely why this self-check exists.

Sandbox workspaces do **not** live under the release directory. They live under
`EVELAND_SANDBOX_CACHE_DIR` (default `$EVELAND_DATA_DIR/sandbox`), one subdirectory per
project, because eve 0.22.0 keys session sandboxes per durable session rather than per
deployment — a redeploy no longer discards a session's `/workspace` state. Since
eveland gives every release a fresh release directory, deriving the cache from the
release (as an unconfigured `@evelandhq/sandbox-bwrap` normally would) would have silently
destroyed every session's workspace on the next redeploy. The systemd unit is granted
this directory read-write via a second `ReadWritePaths=` property (alongside the one for
the release directory itself). A Docker Deployment gets the Docker-host view of the
same Project directory as a bind mount. Both expose the runtime-visible location as
`EVELAND_SANDBOX_CACHE_DIR`.

Every generated sandbox module also passes `EVELAND_SANDBOX_RUN_TIMEOUT_MS`,
`EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES`, and `EVELAND_SANDBOX_MAX_OUTPUT_BYTES` to
the vendored backend. A `run()` command that exceeds the default 10-minute deadline or
16 MiB combined output budget is aborted and its complete detached bwrap process group
is killed. A compute generation admits at most 64 live commands by default; `spawn()`
remains the explicit API for a long-running process and counts against that admission
ceiling while alive. These command boundaries are backed by the
Deployment cgroup limits above: Docker applies memory, CPU, and PID limits to the outer
Agent container, while systemd applies `MemoryMax`, `CPUQuota`, and `TasksMax` to the
transient unit, including every sandbox child.

The sandbox cache (both session and Release-revisioned template directories under
`EVELAND_SANDBOX_CACHE_DIR`) grows with the number of durable sessions and unique
templates and is **not** pruned automatically by Eveland. The vendored backend exposes
metadata-backed, dry-run-first list/prune APIs with age/LRU policies and active-generation
leases; Eveland does not schedule them yet. Prefer those APIs over deleting hash-named
directories by hand, and always inspect a dry run before applying deletion.

See [`evelandhq/sandbox-bwrap`](https://github.com/evelandhq/sandbox-bwrap)'s README
for the full backend behavior and security boundary.

## Reverse proxy

If you route by path in front of a deployment, forward **both** `/eve/` and
`/.well-known/workflow/`. The workflow world delivers run callbacks to
`/.well-known/workflow/v1/flow`; forwarding only `/eve/` lets sessions start but
stalls every run silently.

## Logs

`journalctl -u eveland-<project>-<deployment>.service`

### Scheduler and activation troubleshooting

Start in authenticated **Settings > About**. Confirm API shows
`EVELAND_ACTIVATION_LEASE_TTL_MS` and `EVELAND_COLD_START_TIMEOUT_MS`, Gateway
shows `EVELAND_API_INTERNAL_URL` and `EVELAND_ACTIVATION_RENEW_INTERVAL_MS`, and
Worker shows the idle/recovery/reconciliation values. Values are allowlisted;
secrets remain fixed-mask and URL credentials/query values are removed.

For a cron/manual failure, open the ScheduleRun detail under the Project's
Sessions history. It records status, attempt, missed ticks, exact
Release/Deployment/ScheduleVersion, timings, a sanitized error, aggregate
provider usage, and zero or more linked Sessions. `failed` before dispatch has
zero fabricated Sessions. `dispatch_unknown` means the credential was redeemed
but the result was lost, so Eveland deliberately does not replay the authored
side effect automatically. Use the run ID to correlate the Project Runtime log
and `journalctl -u eveland-<project>-<deployment>.service`; never paste decrypted
Project Secrets, scheduler credentials, affinity cookies, or raw env files into
the UI or logs.

For a cold-start failure, compare the Deployment and latest RuntimeInstance:
`starting` should have one coalesced `ensure_deployment_running` job, `failed`
retains `lastError`, and `stopped` is a normal dormant state. Check API/Gateway
service-token agreement and reachability of `EVELAND_API_INTERNAL_URL`, then
inspect the owning runtime (`systemctl status`/`journalctl` for systemd). A
client abort releases only that request lease; other active leases must remain.
For schedules, confirm Worker reports `EVELAND_SCHEDULER_PREWARM_MS`. An enabled
schedule inside that window keeps its target out of idle reaping, while a stopped
target receives a coalesced activation job. A short `draining` transition is
retried before dispatch and should not appear as a terminal ScheduleRun failure.
A dispatch that returns Session IDs remains `running` until Built-in projects a
root turn boundary from private OTLP logs for every returned Session. Its schedule lease protects the exact
RuntimeInstance beyond the normal five-minute idle TTL. If that RuntimeInstance
disappears, reconciliation records `platform.runtime_lost` and fails the affected
Session and ScheduleRun; if no boundary arrives before
`EVELAND_SCHEDULE_RUN_MAX_RUNTIME_MS`, it records
`platform.runtime_deadline_exceeded` instead.

## Capacity planning (single host)

Eveland is designed to run a fleet of Agents on one machine, so the practical
question is how machine size maps to concurrent workload. Three workload kinds
compete for the host, in decreasing memory weight:

| Workload                                                       | Memory (typical) | CPU                     | Postgres connections                                                                           |
| -------------------------------------------------------------- | ---------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| One **build** (`npm ci`/`npx eve build`)                       | 1–2 GB peak      | high (bursts, ~2 cores) | none — build env deliberately excludes all database URLs                                       |
| One **running Agent** (`npx eve start`)                        | 150–300 MB RSS   | low while idle          | up to `WORKFLOW_POSTGRES_MAX_POOL_SIZE` (default 10) + control-plane request load it generates |
| Control plane (API, Gateway, Web, worker, Postgres, Collector) | ~1–1.5 GB total  | low                     | ~30 (`DATABASE_POOL_SIZE` × API/Gateway/worker)                                                |

Concurrency is governed as follows:

- **Running Agents**: no hard cap. The idle reaper stops any Agent with no
  activation lease for five minutes (`EVELAND_ACTIVATION_IDLE_TTL_MS`), so the
  steady-state count follows real traffic, not the number of projects.
- **Builds**: at most one running job **per project**, plus a global cap on
  concurrently running builds. The worker derives the cap from the machine at
  startup — `max(1, min(⌊RAM / 4 GiB⌋, cores − 2))`, matching the reference
  table below — and logs it at boot; `EVELAND_MAX_CONCURRENT_JOBS` overrides
  it. Builds beyond the cap stay queued while cheap jobs (restart, archive,
  delete, import) keep flowing, and admission remains one new job per worker
  tick (`WORKER_POLL_INTERVAL_MS`, default 5 s). The health page's Workload
  section shows current usage as "Running builds N/cap".

Postgres deserves a clarification, because `max_connections` is the limit
operators reach first (`FATAL 53300: sorry, too many clients already` at Agent
startup): **connections are a bookkeeping ceiling, not the scarce resource**.
Raising `max_connections` costs almost nothing until connections actually
exist, and an idle backend is roughly 2 MB — 300 mostly-idle connections is
under 1 GB. The Agents _holding_ those connections cost far more than the
connections themselves, so RAM runs out at the process level first. Size in
this order:

1. Budget RAM: `total − 2 GB (OS + control plane) − builds × 2 GB` → divide by
   ~0.3 GB for the sustainable running-Agent count.
2. Set `max_connections ≈ agents × WORKFLOW_POSTGRES_MAX_POOL_SIZE + 30
(control plane) + headroom`. Lower the pool size to fit more Agents per
   instance when workflows are light.

Reference points (the "Concurrent builds" column is what the worker's derived
cap enforces on a typical host of that size — memory-bound at one build per
4 GB, limited to cores − 2 on CPU-lean machines):

| Host  | Concurrent builds | Running Agents | `max_connections` |
| ----- | ----------------- | -------------- | ----------------- |
| 4 GB  | 1                 | ~5             | default 100       |
| 8 GB  | 2                 | ~10–15         | 200               |
| 16 GB | 3–4               | ~30            | 300–400           |
| 32 GB | 6–8               | ~60            | 400+ (pool 5)     |

## Known limits (v1)

- Eveland does not automatically prune the sandbox cache under
  `EVELAND_SANDBOX_CACHE_DIR`; disk usage grows with the number of durable sessions and
  unique templates. The backend's explicit dry-run/list/prune API is available to an
  operator (see "Agent exec sandbox" above).
- Each active Docker Deployment uses one bridge subnet. Capacity is bounded by
  Docker's configured `default-address-pools`; the recommended `/16` split into
  `/24` networks permits 256 concurrent managed networks, including other Docker
  bridges on the same daemon.
- An eve project with no `agent/` directory, or a plain Node project, gets no injected
  sandbox and runs on eve's default sandbox chain. Under production-style `eve start`,
  the optional `just-bash` peer may be absent; even when installed it cannot run real
  Node or TypeScript binaries.
- systemd Deployment processes use `systemd-run --collect` transient units and
  therefore do not restart automatically after a host reboot. The enabled Worker
  does restart, reconciles stale `ready` RuntimeInstances to `stopped`/`failed`,
  and the next cron or Gateway request cold-starts the preserved exact Release.
  The immutable Deployment, routes, history, and SessionBindings survive; only
  the transient process is absent during the cold interval.

## Verifying the setup: Lima integration smoke test

`infra/lima/eveland.yaml` and `infra/integration/run.sh` provision an Ubuntu
24.04 Lima VM and run `apps/worker/src/integration/systemd-smoke.ts` end to end
through the real job pipeline (the PGlite-backed SQL Store + `processNextJob`) against
the real systemd adapter: import a fixture project, build it under bwrap,
start it as a transient unit, poll health, fetch the running service, then
tear the unit down.

```bash
brew install lima
bash infra/integration/run.sh
```

The script reuses a VM named `eveland-test` across runs (creating it on first
use), provisions the complete host-owned sandbox toolchain, and rsyncs the
read-only repo mount into `/opt/eveland` before running `pnpm install` and the
smoke test as root inside the guest. A successful run
exits 0 and prints `SMOKE OK`. If it fails, inspect the unit logs from the
host: `limactl shell eveland-test -- sudo journalctl -u 'eveland-*' --no-pager | tail -50`.

The same script also runs real Eve 0.29.x, 0.30.x, and 0.31.x compatibility fixtures through the
systemd adapter. It proves a dormant scheduler target wakes for one due cron,
executes the authored TypeScript definition once, exports standard OTLP logs, projects two Sessions and
provider usage, observes no duplicate from the neutralized native tick, stops
after idle TTL, and wakes the bound Deployment for a later public continuation.
Success prints `SCHEDULE SCALE TO ZERO E2E OK`.

The same real systemd/bwrap path also builds and runs the Managed Connections
fixture. It verifies official Eve OpenAPI and MCP Connections on the root Agent,
an MCP Connection owned by a directory-form subagent, distinct Project Secret
Bearer credentials, restart, a second immutable Release, build-derived root
Connection summary, and secret non-leakage. Success prints
`MANAGED CONNECTIONS E2E OK runtime=systemd`.

Eve 0.27.4+ session reset requires migration `0029_sparkling_hammerhead`: it backfills the latest known
continuation token into each Gateway SessionBinding and adds the unique routing index used by public and
Playground reset requests. Apply migrations before rolling API/Gateway/Worker processes. Eve 0.27.6 remote
principal forwarding remains Agent-owned and opt-in on both deployments; do not add a permissive
`trustedForwarders` predicate as a platform workaround.

Eve 0.37.1 create-once routing requires migration `0050_regular_lenny_balinger`, which adds the
HMAC-keyed Gateway OperationBinding. Apply it before rolling Gateway. OperationBindings use the same
trigger-specific idle TTL as SessionBindings and protect their exact Deployment artifact while active;
task-input tokens remain opaque and are never stored.

The backend's own contract test is no longer part of this script — it belongs to
`evelandhq/sandbox-bwrap`, which runs it under these same systemd constraints via
that repository's `infra/smoke.sh`. What this script still proves is the
integration: an imported project gets a working bwrap sandbox it never declared,
and a redeploy preserves the durable session workspace. A fully successful run
prints `SMOKE OK`.
