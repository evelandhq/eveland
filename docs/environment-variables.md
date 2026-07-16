# Environment variables

This is a reference for every environment variable the **eveland platform** reads
(API, worker, gateway, DB, and the embedded observer/collector). Defaults and the
reading site are listed so an operator can see what is optional and where a value
takes effect.

**Test-only** variables — read solely by test/integration harnesses — are explicitly
**out of scope** and listed at the end so they are not confused with platform config.

Unless noted, a variable is read via `process.env` at process start. "Required in
production" means the process throws or a deploy is blocked when it is missing.

---

## Storage

| Variable | Purpose | Default | Read by |
| --- | --- | --- | --- |
| `DATABASE_URL` | eveland's own control-plane Postgres (projects, deployments, sessions, secrets, logs, …). | — (required) | DB (`packages/db/src/client.ts`) |
| `DATABASE_POOL_SIZE` | Max connections in the pg pool. | `10` | `packages/db/src/client.ts` |
| `STORE_DRIVER` | Set to `memory` for the in-memory store (ephemeral/dev); anything else uses Postgres. | Postgres | `packages/db/src/store-factory.ts` |
| `WORKFLOW_POSTGRES_URL` | Platform-owned workflow Postgres **base** URL. The worker forces `@workflow/world-postgres` in prepared Releases and fails fast without this URL in production. Each project gets its own derived database (`eveland_wf_<project>_<digest>`), created and bootstrapped before any process starts, so runtimes never share a workflow queue; the base URL's role therefore needs `CREATEDB`. Reserved: Project Secrets cannot override it. | — | worker (`apps/worker/src/jobs/process.ts`, `apps/worker/src/runtime/workflow-world-bootstrap.ts`) |
| `WORKFLOW_POSTGRES_BOOTSTRAP_URL` | Optional worker-reachable address for the same workflow database. Used only for startup schema bootstrap when the deployment URL is container-specific. | Matching `DATABASE_URL` when `WORKFLOW_POSTGRES_URL` uses `host.docker.internal`; otherwise `WORKFLOW_POSTGRES_URL` | worker (`apps/worker/src/runtime/workflow-world-bootstrap.ts`) |

> **`WORKFLOW_POSTGRES_URL` must use a container-reachable host** (e.g.
> `host.docker.internal`), not `localhost`, because agent containers reach the host DB
> from inside the container. The optional bootstrap URL may instead use
> `localhost` or a Compose service name because only the worker reads it. For
> the common single-database setup, the worker also recognizes a `DATABASE_URL`
> that differs only by host and uses that reachable URL for bootstrap.

## Encryption

| Variable | Purpose | Default | Read by |
| --- | --- | --- | --- |
| `APP_SECRET_KEY` | Symmetric key (aes-256-gcm) for encrypting/decrypting project secrets. The API encrypts on write; the worker decrypts before injecting into a deployment. Validated by `assertValidSecretKey`. | dev-only `eveland-dev-secret-key-000000000` | API + worker |

> **Change `APP_SECRET_KEY` in production.** Leaving the dev default in place means
> stored secrets are effectively unprotected.

## Ports and web

| Variable | Purpose | Default | Read by |
| --- | --- | --- | --- |
| `PORT` | API listen port. | `4000` | `apps/api/src/server.ts` |
| `GATEWAY_PORT` | Gateway listen port. | `4080` | `apps/gateway/src/server.ts` |
| `WEB_ORIGIN` | API CORS `allow-origin`. | `http://localhost:3000` | `apps/api/src/app.ts` |
| `NEXT_PUBLIC_API_URL` | API base URL used from the **browser** (Next.js, baked in at build time). | `http://localhost:4000` | web |
| `API_URL` | API base URL used from the web app's **server side** (SSR). | `http://localhost:4000` | web |

> **`WEB_ORIGIN` must exactly match the origin the browser uses to reach the web app**
> (scheme, host, and port). A mismatch makes the browser's calls fail CORS
> ("Failed to fetch").

## Runtime / deployment (worker)

| Variable | Purpose | Default | Read by |
| --- | --- | --- | --- |
| `NODE_ENV` | When `production`: the runtime defaults to `systemd`, `NODE_ENV=production` is injected into the agent, deploy gates are enforced, and the gateway's dev fallbacks are disabled. | — | multiple |
| `EVELAND_RUNTIME` | Explicitly select `docker` or `systemd`; **overrides** the `NODE_ENV` inference. | inferred from `NODE_ENV` | `apps/worker/src/runtime/select.ts` |
| `EVELAND_DATA_DIR` | Data root (sources, builds, observer, sandbox, deployment-env). API and worker must agree on it; the systemd runtime requires an absolute path. | `.eveland-data` | API + worker |
| `EVELAND_HOST_DATA_DIR` | Host-side real path when the worker runs inside Compose but drives the host Docker daemon (used to bind the observer outbox into agent containers). | same as `EVELAND_DATA_DIR` | worker (`process.ts`) |
| `EVELAND_INTERNAL_PORT` | Container-internal port for the docker adapter. | `3000` | `apps/worker/src/runtime/select.ts` |
| `EVELAND_DEPLOYMENT_PORT` | Start of the host-port allocation range (scans the next 100 ports for a free one). | `41000` | `apps/worker/src/jobs/process.ts` |
| `EVELAND_HEALTH_TIMEOUT_MS` | Timeout waiting for a freshly started deployment to pass its health check. | `15000` | worker (`process.ts`) |
| `EVELAND_RELEASE_RETENTION` | Deployments/releases retained per project by the archive policy. | `3` (minimum 3) | worker (`process.ts`) |
| `WORKER_ID` | Worker instance identity, used when claiming jobs. | — | `apps/worker/src/worker.ts` |
| `WORKER_POLL_INTERVAL_MS` | Interval between worker job-queue polls. | `5000` | `apps/worker/src/worker.ts` |
| `EVELAND_ORPHAN_SWEEP_INTERVAL_MS` | Interval between orphan-process sweeps that reconcile running `eveland-*-dep_*` host processes with the control plane (adopt into RuntimeInstance lifecycle, or stop unknown/archived/wrong-runtime leftovers). `0` disables the sweep. | `3600000` (1 hour) | `apps/worker/src/worker.ts` |
| `EVELAND_ORPHAN_GRACE_MS` | How long a running process may stay out-of-model before the sweep stops it; covers the window where `build_deploy` starts a process before its Deployment row exists. | `300000` | `apps/worker/src/runtime/orphan-reaper.ts` |
| `PATH` | Passed through (allowlisted) to build and sandbox child processes. | system `PATH` | worker (`systemd.ts`) |

## systemd runtime (Linux / production only)

These take effect only on the systemd runtime; the docker runtime ignores them.

| Variable | Purpose | Default |
| --- | --- | --- |
| `EVELAND_APP_USER` | Unix service user that runs the deployed agent process. | `eveland-app` |
| `EVELAND_BUILD_USER` | Unprivileged Unix user that runs `npm ci` / `npx eve build`. | `eveland-build` |
| `EVELAND_MEMORY_MAX` | systemd unit `MemoryMax`. | `2G` |
| `EVELAND_CPU_QUOTA` | systemd unit `CPUQuota`. | `200%` |
| `EVELAND_BUILD_SANDBOX` | `none` disables the bwrap wrapper around the build; also drops `bwrap` from the preflight's required-binary list. | `bwrap` |
| `EVELAND_SANDBOX_CACHE_DIR` | Root for bwrap template/session persistent caches (one subdirectory per project). | `<EVELAND_DATA_DIR>/sandbox` |
| `EVELAND_OBSERVER_OUTBOX_DIR` | Observer event outbox directory, passed into the agent via the unit environment. | derived at deploy time |

> **`EVELAND_SANDBOX_CACHE_DIR` must live outside the release directory.** Since eve
> 0.22 keys session sandboxes per durable session, a cache inside the release dir would
> be discarded on redeploy — destroying each session's `/workspace`. See
> [`docs/deploy/linux.md`](./deploy/linux.md) for host provisioning.

## Gateway (data plane)

| Variable | Purpose | Default | Read by |
| --- | --- | --- | --- |
| `EVELAND_AGENT_BASE_DOMAINS` | Allowed agent base domains (comma-separated); the first one is used to materialize routes. | `agent.localhost` | gateway + worker |
| `EVELAND_GATEWAY_AFFINITY_SECRET` | Signs the session-affinity cookie. **Required in production** (the gateway throws without it). | dev-only `eveland-dev-affinity-secret` | `apps/gateway/src/server.ts` |
| `EVELAND_GATEWAY_PUBLIC_SCHEME` | `http` or `https`; sets the `Secure` flag on the affinity cookie. | `http` | `apps/gateway/src/server.ts` |
| `EVELAND_GATEWAY_PUBLIC_PORT` | Publicly advertised port (used to build playground URLs). | — | gateway app options |
| `EVELAND_GATEWAY_MAX_REQUEST_BODY_BYTES` | Cap on proxied request-body size. | `10485760` (10 MiB) | `apps/gateway/src/server.ts` |
| `EVELAND_GATEWAY_SERVICE_TOKEN` | Protects the gateway's `/internal` routes (cache invalidation, playground). In production without it, `/internal` has no token guard. | dev-only `eveland-dev-gateway-token` | `apps/gateway/src/server.ts` |
| `EVELAND_GATEWAY_INTERNAL_URL` | The API's callback URL to the gateway's `/internal` routes. | — | worker (`process.ts`) |
| `EVELAND_PLAYGROUND_TIMEOUT_MS` | Timeout for a gateway playground request. | — | `apps/gateway/src/app.ts` |

> **Route-cache invalidation needs both `EVELAND_GATEWAY_INTERNAL_URL` and
> `EVELAND_GATEWAY_SERVICE_TOKEN`.** If either is missing, the API silently skips
> invalidation and route changes only take effect after the cache TTL. This pair has no
> dev fallback.

## Observability (collector + observer)

| Variable | Purpose | Default | Read by |
| --- | --- | --- | --- |
| `EVELAND_COLLECTOR_MODE` | Embedded session collector switch: `embedded` or `disabled`. | `embedded` | `apps/api/src/server.ts` |
| `EVELAND_OBSERVER_ROOT` | Root directory the collector reads events from. | `<EVELAND_DATA_DIR>/observer` | `apps/api/src/server.ts` |
| `EVELAND_COLLECTOR_MAX_CONCURRENT_SESSIONS` | Collector concurrency cap. | `100` | `apps/api/src/server.ts` |
| `EVELAND_COLLECTOR_MAX_BACKLOG_BYTES` | Collector backlog byte cap. | `1073741824` (1 GiB) | `apps/api/src/server.ts` |
| `EVELAND_OBSERVER_INCLUDE_REASONING` | Set to `"true"` to also collect `reasoning.completed` events. | not collected | `packages/agent-observer/src/injector.ts` |
| `EVELAND_DEPLOYMENT_ID` | Current deployment id, injected into the agent for observer event tagging. | injected at deploy time | worker (`process.ts`) |

---

## Test-only variables

Read only by test or integration harnesses; not part of runtime configuration:

- `EVELAND_POSTGRES_TEST_URL` — Postgres integration tests.
- `STORE_DRIVER=memory` — in-memory store for tests.
- `E2E_CHECK_MODE` — agent-sandbox end-to-end check.
- `SMOKE_SECRET` — bwrap / systemd smoke tests.
- `EVE_EXAMPLE_MODEL`, `EVE_EXAMPLE_REAL_LLM` — example-agent tests.
