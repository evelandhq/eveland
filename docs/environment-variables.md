# Environment variables

This is a reference for every environment variable the **eveland platform** reads
(API, worker, gateway, DB, and the managed OpenTelemetry Collector). Defaults and the
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
| `WORKFLOW_POSTGRES_URL` | Platform-owned workflow Postgres **base** URL. The worker forces `@workflow/world-postgres` in prepared Releases and fails fast without this URL in production. Each project gets its own derived database (`eveland_wf_<project>_<digest>`), created and bootstrapped before any process starts, so runtimes never share a workflow queue; the base URL's role therefore needs `CREATEDB`. Reserved: Project Secrets cannot override it. | — | worker (`apps/worker/src/jobs/process-support.ts`, `apps/worker/src/runtime/workflow-world-bootstrap.ts`) |
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
| `APP_SECRET_KEY` | Symmetric key (aes-256-gcm) for project secrets and personal Git host credentials. The API encrypts on write; the worker decrypts project secrets for deployments and GitLab PATs only for host-scoped source clone authentication. Validated by `assertValidSecretKey`. | dev-only `eveland-dev-secret-key-000000000` | API + worker |

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

## Agent-user Identity

| Variable | Purpose | Default | Read by |
| --- | --- | --- | --- |
| `EVELAND_IDENTITY_ISSUER` | Stable public issuer embedded in Eveland Caller Tokens. It must match the issuer configured by every consuming chat service and Agent verifier. | `http://localhost:4000` | API + worker |
| `EVELAND_IDENTITY_ALLOWED_ORIGINS` | Comma-separated exact browser origins allowed to read Identity Session state, request Caller Tokens, and log out. The public Agent Catalog does not depend on this allowlist. Wildcards are not supported. | `http://localhost:3010` | API |
| `EVELAND_IDENTITY_JWKS_URL` | Agent-reachable public-key URL injected into every Deployment. It may use a private/loopback address while `EVELAND_IDENTITY_ISSUER` remains the stable public issuer. | `http://host.docker.internal:4000/.well-known/jwks.json` | worker |
| `EVELAND_PROJECT_ID` | Audience/project binding injected by the worker into each Agent Deployment. Project and Shared Agent Environment values cannot override it. | current Project ID | deployed Agent |

The `eveland_identity` cookie is separate from Better Auth and scoped to `/identity`;
`/agent-catalog` is a public, identity-independent projection.
Caller Tokens are ES256, short-lived, and authenticate a principal to one Project audience;
Agents remain responsible for business authorization. Register browser return origins in
System > Identity; environment CORS configuration does not create or widen that redirect
allowlist.

Native development supplies the table defaults even when an older local `.env`
does not contain these variables. The API and Worker development watchers also
watch the shared `.env`. When the injected issuer or JWKS URL changes, the
Worker records a configuration fingerprint and queues one targeted restart for
each live Deployment so running Agents cannot keep stale verifier settings.
Production does not receive localhost fallbacks and must configure the values
explicitly.

The Internal-provider milestone uses a same-site browser topology. Eveland
Identity and the chat origin must share one schemeful site (normally sibling
HTTPS subdomains), because the Identity cookie is `SameSite=Lax`. Exact CORS
configuration alone does not permit credentialed requests from an unrelated
site.

## Runtime / deployment (worker)

| Variable | Purpose | Default | Read by |
| --- | --- | --- | --- |
| `NODE_ENV` | When `production`: the runtime defaults to `systemd`, `NODE_ENV=production` is injected into the agent, deploy gates are enforced, and the gateway's dev fallbacks are disabled. | — | multiple |
| `EVELAND_RUNTIME` | Explicitly select `docker` or `systemd`; **overrides** the `NODE_ENV` inference. | inferred from `NODE_ENV` | `apps/worker/src/runtime/select.ts` |
| `EVELAND_DATA_DIR` | Data root (sources, builds, Collector configuration, observability policies, sandbox, deployment-env). API and worker must agree on it; the systemd runtime requires an absolute path. | `.eveland-data` | API + worker |
| `EVELAND_HOST_DATA_DIR` | Host-side real path when the worker runs inside Compose but drives the host Docker daemon. It lets Docker validate the generated Collector configuration and bind runtime-owned directories. | same as `EVELAND_DATA_DIR` | worker |
| `EVELAND_INTERNAL_PORT` | Container-internal port for the docker adapter. | `3000` | `apps/worker/src/runtime/select.ts` |
| `EVELAND_DEPLOYMENT_PORT` | Start of the host-port allocation range (scans the next 100 ports for a free one). | `41000` | `apps/worker/src/jobs/process-support.ts` |
| `EVELAND_GIT_CLONE_TIMEOUT_MS` | Maximum duration of a non-interactive Git source clone before the worker fails the import and removes its partial source directory. | `120000` | worker (`source/importer.ts`) |
| `EVELAND_GIT_CLONE_MAX_ATTEMPTS` | Maximum attempts for transient DNS, connection, TLS, timeout, and HTTP 5xx clone failures. | `3` | worker (`source/importer.ts`) |
| `EVELAND_GIT_CLONE_RETRY_DELAY_MS` | Initial Git retry delay; each subsequent retry doubles it. | `1000` | worker (`source/importer.ts`) |
| `EVELAND_HEALTH_TIMEOUT_MS` | Timeout waiting for a freshly started deployment to pass its health check. On failure the worker captures masked, bounded runtime state and recent logs before cleanup. | `15000` | worker (`process.ts`) |
| `EVELAND_PLAYGROUND_SESSION_IDLE_TTL_MS` | Idle time before a Playground SessionBinding stops protecting its Deployment. Keep the value identical across API, Gateway, and worker. | `86400000` (24 hours) | API + Gateway + worker |
| `EVELAND_API_SESSION_IDLE_TTL_MS` | Idle time before a public API SessionBinding stops protecting its Deployment. Keep the value identical across API, Gateway, and worker. | `604800000` (7 days) | API + Gateway + worker |
| `EVELAND_SCHEDULE_RUN_MAX_RUNTIME_MS` | Hard safety deadline for a dispatched ScheduleRun whose Observer never reports a turn boundary. It is independent from the activation idle TTL. | `86400000` (24 hours) | worker |
| `EVELAND_RELEASE_RETENTION` | Minimum newest Deployments/releases retained per project by the automatic archive policy. Route targets, non-expired SessionBindings, and active request leases remain protected independently of age. | `3` (minimum 3) | API + worker |
| `EVELAND_RELEASE_SWEEP_INTERVAL_MS` | Interval between automatic scans that enqueue archive jobs for unprotected stopped Deployments. `0` disables the automatic sweep. | `3600000` (1 hour) | worker (`worker.ts`) |
| `EVELAND_RELEASE_SWEEP_BATCH_SIZE` | Maximum new archive jobs enqueued by one automatic Release sweep. | `25` | worker (`runtime/release-reaper.ts`) |
| `WORKER_ID` | Worker instance identity, used when claiming jobs. | — | `apps/worker/src/worker.ts` |
| `WORKER_POLL_INTERVAL_MS` | Interval between worker job-queue polls. | `5000` | `apps/worker/src/worker.ts` |
| `WORKER_JOB_HEARTBEAT_INTERVAL_MS` | Interval between running job lease renewals. Keep it comfortably below `WORKER_JOB_STALE_MS`. | `30000` | worker (`jobs/process.ts`) |
| `WORKER_JOB_STALE_MS` | Time without a successful heartbeat before a running job is re-queued for recovery. | `120000` | worker (`worker.ts`) |
| `WORKER_JOB_RECOVERY_BATCH_SIZE` | Maximum stale jobs re-queued in one worker tick. | `25` | worker (`worker.ts`) |
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

## Observability (OpenTelemetry)

| Variable | Purpose | Default | Read by |
| --- | --- | --- | --- |
| `EVELAND_OTLP_ENDPOINT` | Internal OTLP/HTTP receiver used by Eveland-owned API, Gateway, Worker, and injected Agent providers. This is deployment topology, not the admin capture switch or an external destination. | `http://127.0.0.1:4318` | API + Gateway + Worker |
| `EVELAND_OTLP_SERVICE_TOKEN` | Service credential used only between the managed Collector and Built-in API ingest. Configure the same value on both services. | dev-only value in Compose | API + Collector |
| `EVELAND_OTEL_METRIC_INTERVAL_MS` | Export interval for platform SDK metrics. | `60000` | API + Gateway + Worker |
| `EVELAND_HOST_METRIC_INTERVAL_MS` | Worker cadence for emitting standard host CPU, memory, filesystem, workload, and heartbeat metrics. | `60000` | Worker |
| `EVELAND_BUILTIN_OTLP_ENDPOINT` | Internal API endpoint used by the Collector's always-on Built-in exporter. | topology-specific Compose value | Collector |
| `EVELAND_OTEL_COLLECTOR_CONTAINER` | Managed Collector container name used by Compose and by Worker when applying a validated configuration revision. | `eveland-otel-collector` | Compose + Worker |
| `EVELAND_OTEL_COLLECTOR_IMAGE` | Collector image used by Worker for configuration validation. Keep it aligned with the running Collector image. | `otel/opentelemetry-collector-contrib:0.149.0` | Worker |
| `EVELAND_DEPLOYMENT_ID` | Current Deployment id injected into the Agent runtime. | injected at deploy time | Worker |

Built-in, Agent capture, sampling, content policy, Elastic, Langfuse, and custom
OTLP destinations are revisioned System settings stored in Postgres. They are
intentionally not environment variables. User-authored instrumentation remains
independent and continues to use the providers/exporters configured in Agent source.

---

## Test-only variables

Read only by test or integration harnesses; not part of runtime configuration:

- `EVELAND_POSTGRES_TEST_URL` — Postgres integration tests.
- PGlite-backed tests require no environment variable; they run the production SQL Store against a fresh migrated database.
- `E2E_CHECK_MODE` — agent-sandbox end-to-end check.
- `SMOKE_SECRET` — bwrap / systemd smoke tests.
- `EVE_EXAMPLE_MODEL`, `EVE_EXAMPLE_REAL_LLM` — example-agent tests.
