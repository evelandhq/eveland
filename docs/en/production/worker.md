---
title: Install the host Worker
description: Install the privileged Worker as a systemd service and connect it to the core services.
---

Worker is the only runtime controller. Production keeps it on the host so API and the Agent Gateway never receive systemd or Docker-controller privilege.

## Install the checkout

Worker runs as root from its own checkout at `/opt/eveland` (see `infra/systemd/eveland-worker.service`). Apply the same `vX.Y.Z` tag as the core services and install the frozen lockfile:

```bash
cd /opt/eveland
git fetch --tags origin
git checkout vX.Y.Z
pnpm install --frozen-lockfile
```

`@evelandhq/sandbox-bwrap` — the only dependency whose compiled output is vendored into every Agent Release — ships prebuilt from npm, pinned by the lockfile. The frozen install therefore gets the exact backend that tag was tested against; there is no separate sandbox-backend build step.

## Install the service

```bash
sudo install -d -m 0750 /etc/eveland
sudo cp infra/systemd/eveland-worker.env.example /etc/eveland/eveland-worker.env
sudo cp infra/systemd/eveland-worker.service /etc/systemd/system/
```

Configure the environment file before starting the service, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eveland-worker
```

## Configure the environment file

`infra/systemd/eveland-worker.env.example` documents every entry. The values that must agree with other components:

- `EVELAND_RUNTIME=systemd` and `NODE_ENV=production`. `NODE_ENV=production` already defaults the runtime to systemd, but keep the explicit value so the file documents the host's runtime unambiguously.
- `EVELAND_DATA_DIR=/var/lib/eveland` — the exact absolute path the API container mounts.
- `DATABASE_URL` — the platform database.
- `EVELAND_WORKFLOW_WORLD_URL` (and `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL` when needed) — the shared workflow database; must equal the dispatcher's value.
- `APP_SECRET_KEY` — must match the API's value. After rotation, redeploy every Agent Deployment so its telemetry credential is signed by the new key.
- `EVELAND_GATEWAY_SERVICE_TOKEN`, `EVELAND_GATEWAY_INTERNAL_URL` — Agent Gateway service authentication.
- `EVELAND_SCHEDULER_RUNTIME_SECRET`, `EVELAND_SCHEDULER_DISPATCH_SECRET`, `EVELAND_SCHEDULER_REDEEM_URL` — scheduler authentication; the runtime secret must also match the dispatcher's value.
- `EVELAND_IDENTITY_ISSUER`, `EVELAND_IDENTITY_JWKS_URL` — the same stable issuer as the API; JWKS may use host loopback because systemd Agents run on this host.
- `EVELAND_AGENT_BASE_DOMAINS`, `EVELAND_OTLP_SERVICE_TOKEN`, `EVELAND_RELEASE_CHANNEL`, `EVELAND_REVISION` — aligned with the core services.

Per-Deployment resource ceilings (`EVELAND_MEMORY_MAX`, `EVELAND_CPU_QUOTA`, `EVELAND_TASKS_MAX`) and every optional knob are in the [environment-variable reference](/docs/reference/environment-variables); size them with [Capacity planning](/docs/operations/capacity).

## Build trust boundary

Building a Project executes that Project's dependency lifecycle scripts (`pnpm install`/`npm ci`/`npm install`, e.g. `postinstall`) inside the build sandbox as the unprivileged build user (`EVELAND_BUILD_USER`, default `eveland-build`), never as root. Imported Projects — and their full dependency trees — are trusted only up to that sandbox's boundary: nothing outside the release directory and the shared npm cache is writable, and the Eveland data dir (other Projects' builds, sources, and decrypted secret env files) is hidden entirely, regardless of which user is inside. The rest of the host filesystem stays read-only visible to the build, which retains network access. `EVELAND_BUILD_SANDBOX=none` disables this sandbox and is not recommended.

Worker secrets are hidden by a different mechanism: the Worker's own environment (`APP_SECRET_KEY`, `DATABASE_URL`, and the rest of its `process.env`) would otherwise be inherited by the build subprocess and readable through `/proc/self/environ`. Both build modes instead construct the subprocess environment from a fixed allowlist — `PATH` and `npm_config_cache` — so no Worker secret ever reaches a build. `HOME` is not on that allowlist because `runuser` resets it during the user switch; it is injected after the switch, pointed at the release directory. The allowlist also deliberately drops operator proxy configuration (`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`, `npm_config_registry`): a host that needs a proxy to reach the npm registry needs a mirror reachable without env-borne proxy config today.

The Project's own Agent environment joins that allowlist, but only its `variable` entries — never a `secret`, from either the Project's environment or the Shared Agent Environment. `npx eve build` imports the Project's agent config to compile the Release manifest, so a config resolving a compile-time value from `process.env` would otherwise freeze its authored fallback into every turn the Release reports. A `variable` is operator-declared non-secret configuration and may cross into a boundary where untrusted lifecycle scripts can read it; a `secret` cannot, and reaches the deployed process only.

Two groups of names stay platform-owned; an entry claiming either is dropped from the build with a `WARNING` in the build log — never silently:

- **`PATH`, `HOME`, `NPM_CONFIG_CACHE`** — the build's own toolchain. `NPM_CONFIG_CACHE` because npm reads it case-insensitively alongside `npm_config_cache`, so an entry using it could redirect the shared cache. These still reach the deployed process normally.
- **Every name the platform reserves at runtime** — `NODE_ENV`, `EVELAND_PROJECT_ID`, `EVELAND_IDENTITY_ISSUER`, `EVELAND_IDENTITY_JWKS_URL`, `EVELAND_MEMORY_ROOT`, `EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES`, `EVELAND_SANDBOX_MAX_OUTPUT_BYTES`, `EVELAND_SANDBOX_RUN_TIMEOUT_MS`, `EVELAND_SCHEDULER_REDEEM_URL`, `EVELAND_SCHEDULER_RUNTIME_SECRET`, `EVELAND_WORKFLOW_RUNNER`, `EVELAND_WORKFLOW_STREAM_COMPACTION`, `EVELAND_WORKFLOW_WORLD_URL`, `WORKFLOW_POSTGRES_URL`, `WORKFLOW_POSTGRES_MAX_POOL_SIZE` (kept in sync with `apps/worker/src/runtime/reserved-environment.ts`, locked by a test). The runtime applies these last, so a build that adopted the Project's value would compile against something the deployed process then overrides. `NODE_ENV` is dropped from every build regardless of the host's own value: `npm ci` and `pnpm install --frozen-lockfile` omit devDependencies under `NODE_ENV=production`, which would strip the Project's own build toolchain.

Because a Release is immutable, changing a `variable` refreshes the compiled manifest only on the next deploy — an environment change alone restarts live Deployments onto their existing Release. On the Docker runtime these variables pass as `--build-arg` and appear in image build metadata; the `ARG` declarations sit after the dependency-install layer, so on Docker only pre-discovery, the Extension integrator, `npx eve build`, and the final discovery can read them. The systemd runtime exposes them to install and build in one shell.

## Never switch the resolved runtime

> **WARNING: never switch `EVELAND_RUNTIME` on a host with live Deployments.**

Every Deployment records the `runtimeKind` of the adapter that created it, and stop, restart, and delete always resolve their adapter from that recorded value. A `runtimeKind` that is wrong for the process that actually exists means stopping resolves the wrong adapter: the old process is never stopped and keeps its port, a redeploy crash-loops or quietly leaves two versions running, and health checks can false-pass against the stale process.

Treat the **resolved** runtime as fixed per host, chosen at provisioning time — and remember it can change two ways: flipping `EVELAND_RUNTIME`, or setting `NODE_ENV=production` on a host that leaves `EVELAND_RUNTIME` unset. Preflight catches an accidental flip loudly, but drain first regardless — stop and remove **every** Deployment before switching:

```bash
# systemd host being migrated away from:
systemctl stop 'eveland-*'
systemctl reset-failed 'eveland-*'

# docker host being migrated away from:
docker rm -f $(docker ps -aq --filter "name=eveland-")
```

Only start the Worker with the new runtime once the old runtime has zero `eveland-*` processes left.

## Verify ownership boundaries

- Worker runs as root and controls `systemd-run`, `systemctl`, and filesystem ownership.
- Builds run as the unprivileged build user inside the configured build sandbox.
- Eve processes run under per-Deployment systemd dynamic users with the application access group.
- Worker has no public listener.
- Project Secrets reach only a root-owned `0600` EnvironmentFile for the target process.

Worker refuses to accept jobs while production preflight or the durable workflow configuration is incomplete. Check the service journal and the masked Worker configuration snapshot (`diagnostics/worker-configuration.json` under the data root, surfaced in **Settings → About**) before moving on.

Next, [install the workflow dispatcher](/docs/production/workflow-dispatcher).

## Deeper reference

- [Why systemd, not Docker](/docs/reference/design/runtime): runtime selection and host density rationale
- [Why a bubblewrap sandbox](/docs/reference/design/sandbox): build and execution sandbox isolation
- [Capacity planning](/docs/operations/capacity): calculating concurrent builds, running agents, and database connection limits
