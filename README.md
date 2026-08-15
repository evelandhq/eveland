# Eveland

Self-hosted control plane for importing, deploying, and observing [eve](https://eve.dev)
projects: import an Eve project from a Git repo or Zip upload, configure its runtime
environment, deploy it behind a public Agent gateway, and observe its Sessions, usage,
schedules, and logs.

Product behavior is specified in [`docs/spec.md`](docs/spec.md). This README covers the
repository shape and how to run it.

## Repository layout

- `packages/core`: dependency-free contracts plus explicit Eve protocol, ID, source,
  schedule, archive, secret, and runtime-command subpaths. No root barrel, so
  browser-safe imports cannot pull in Node-only code.
- `packages/db`: Drizzle schema and migrations, and the one domain-oriented SQL Store
  shared by production Postgres and PGlite tests.
- `packages/agent-observer`: release-time Eve hook injection for root, local, and mounted
  Extension directory-form subagents, with private OpenTelemetry providers that never
  register or mutate a user's global providers.
- `packages/agent-auth`: Playground authentication registry, OIDC acquisition
  (Authorization Code + PKCE), and credential materialization.
- `packages/identity-broker`: Agent-user identity finalization, Identity Sessions,
  short-lived project-audience Caller Tokens, signing-key rotation, and public JWKS.
- `packages/agent-scheduler`: release-time injection of the private Scheduler Channel,
  including namespaced schedules contributed or overridden by Eve Extensions.
- `packages/platform-observability`: shared OpenTelemetry SDK bootstrap for API,
  Gateway, and Worker.
- `packages/session-collector`: standard OTLP decoding and projection into the built-in
  Session, usage, and instance-health read models.
- `packages/sdk`: the published `eveland` npm package (`eveland/auth`).
- `packages/architecture-tests`: executable ratchets for the workspace's dependency
  direction, import cycles, full-Store consumers, browser-safe core exports, and
  environment-variable coverage.
- `apps/api`: Hono control-plane API with Better Auth sessions, team membership, and
  the authenticated built-in OTLP ingest endpoint.
- `apps/gateway`: host-routed public Agent data plane. Preserves Agent auth/cookies and
  streaming bodies, pins Eve sessions to deployments, keeps raw Agent ports private.
- `apps/worker`: Docker and systemd runtime adapters plus the Postgres job consumer for
  import, build, restart, and schedule jobs.
- `apps/web`: Next.js App Router control panel (shadcn preset, Tailwind v4).
- `apps/docs`: bilingual public website and documentation for `eveland.ai` (Next.js +
  Fumadocs), separate from the authenticated control panel.

## Contributor code map

The main entrypoints are composers rather than homes for every implementation:

- Database contracts live in `packages/db/src/store-domains.ts`. Add behavior
  to the matching `postgres-*-store.ts` domain module; `postgres-store.ts`
  composes the public Store. Vitest uses the same Store through the PGlite
  helper exported by `@evelandhq/db/vitest`.
- API route families live in `apps/api/src/app-*-routes.ts`, request schemas in
  `app-schemas.ts`, and reusable protocol/request helpers in `app-support.ts`.
  `app.ts` owns cross-cutting auth services, middleware, and composition.
- Worker queue claiming, heartbeats, and terminal fencing live in
  `apps/worker/src/jobs/process.ts`. Import/build and runtime job execution are
  split across `process-job.ts` and `process-runtime-job.ts`;
  `deployment-launch-context.ts` owns the shared environment, command,
  sandbox, and observability inputs while each job handler retains its own
  build/stop/start/health/state lifecycle. Lower-level secret, filesystem, and
  networking helpers live in `process-support.ts`.
- Gateway request/response lifecycle handling lives in
  `apps/gateway/src/gateway-request-lifecycle.ts`; canonical Host validation,
  trusted forwarding headers, affinity cookies, and target selection live in
  `gateway-routing.ts`, while create-once and MCP durable keys live in
  `gateway-durable-routing.ts`. `app.ts` composes the public and privileged
  paths.
- The new-project screen keeps orchestration in
  `apps/web/src/components/new-project-flow.tsx`, with presentation and browser
  request helpers in adjacent `new-project-flow-*` modules.

Large test suites are split by behavior. Reuse colocated `*.test-support.ts`
fixtures rather than duplicating setup when adding coverage.

Eve compatibility has one semantic owner:
`packages/core/src/eve-compatibility.ts`. Workspace consumers reference the
matching pnpm catalogs instead of copying patch versions into package
manifests. The current two-line matrix uses stable positional aliases
(`eve-oldest` and `eve`) so sliding the supported minor window does not rename
consumer dependencies. Standalone integration
fixtures keep the `catalog:` marker in source and are materialized into
temporary directories through `@evelandhq/core/server/eve-fixture` before
import, so an Eve patch upgrade does not require editing every fixture.

## Local development

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env                  # set BETTER_AUTH_SECRET and EVELAND_ADMIN_PASSWORD
docker compose up -d postgres otel-collector # database and platform OTLP receiver
pnpm --filter @evelandhq/api db:migrate  # required on first run and after schema changes
pnpm dev                               # start API, Gateway, web, worker, and docs
```

Open the control panel at `http://localhost:3000` and the public documentation site at
`http://localhost:3001`.

- The initial Admin email defaults to `admin@example.com`; its password comes only from
  `EVELAND_ADMIN_PASSWORD` and must contain at least 12 characters.
  `BETTER_AUTH_SECRET` is a separate random secret of at least 32 characters, and
  `BETTER_AUTH_URL` must be the browser-visible API origin.
- All four processes are required: the web form posts to the API, Playground/public
  Agent traffic goes through Gateway, and imports, builds, and deploys are executed by
  the worker's job polling — without it, projects stay pending after upload.
- The workflow dispatcher waits for the API health endpoint before claiming durable
  jobs, so parallel `pnpm dev` startup does not spend a Graphile retry while the API is
  still binding its port.
- The worker migrates the configured shared workflow database before use and sweeps
  terminal stream chunks in both the legacy per-project and shared topologies. A
  pending disruptive shared-World migration instead blocks unattended startup until
  an operator applies it in the documented maintenance window. The default replay
  window is 24 hours and EOF markers are retained.
- Use `pnpm dev:api`, `pnpm dev:gateway`, `pnpm dev:web`, `pnpm dev:worker`, and
  `pnpm dev:docs` in separate terminals when isolated logs are more useful.
- Public development endpoints use `http://<projectSlug>.agent.localhost:4080`;
  immutable previews use
  `http://<eightCharacterDeploymentKey>--<projectSlug>.agent.localhost:4080`.
  Deployment ports stay bound to `127.0.0.1` and are not product URLs.

Product behavior — the import/preflight flow, the supported Eve version window,
Playground authentication, Agent-user identity and the Agent Catalog, schedules,
deployments, routing, and retention — is specified in [`docs/spec.md`](docs/spec.md).
Operational tunables such as Git clone timeouts and preflight TTLs are listed in
[`docs/environment-variables.md`](docs/environment-variables.md).

### Eve Connections

Eveland deploys source-authored Eve Connections without a separate Connections
configuration page. Managed integration covers MCP and OpenAPI Connections on root
Agents and directory-form subagents, with app-scoped Bearer tokens read from Project
Secrets at runtime. Vercel Connect remains an optional project-level credential helper;
a Vercel account is not required for MCP/OpenAPI Connections on Eveland. Interactive
self-hosted user authorization is not yet in the end-to-end support matrix, and a
Connection marketplace remains out of scope.

### Full stack in Docker Compose

Docker Compose runs the complete stack (Postgres + OpenTelemetry Collector + API +
Gateway + web + worker) in **development mode**:

```bash
docker compose up
```

- Only the worker receives the Docker controller socket; Gateway masks `.eveland-data`
  so the public proxy cannot read imported sources, Collector configuration, or
  encrypted project secrets.
- When the worker runs in Compose, `EVELAND_HOST_DATA_DIR` must be the host-absolute
  path to the workspace's `.eveland-data`.
- Pick one mode: either everything in Compose, or only `postgres`/`otel-collector` in
  Compose and the rest natively. The Compose services run `pnpm install` inside Linux
  containers against the mounted workspace, which clobbers a macOS-built
  `node_modules`.

## Public docs deployment

`apps/docs` is deployed as the `eveland-docs` Cloudflare Worker at
`https://eveland.ai` through the OpenNext adapter. Build or preview the Worker
runtime locally with:

```bash
pnpm --filter @evelandhq/docs build:cloudflare
pnpm --filter @evelandhq/docs preview:cloudflare
```

The `Deploy docs` GitHub Actions workflow deploys after a push to `main` only
when the pushed changes include `apps/docs/**`. It requires the repository
secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (scoped to Workers
edits for the account and zone that own `eveland.ai`).
`apps/docs/wrangler.jsonc` owns the Worker name and custom-domain binding.

## Production (single-box Linux deploy)

The production topology separates the control plane from the privileged runtime
controller:

- Postgres, OpenTelemetry Collector, API, Gateway, and web run through Docker Compose.
- Worker runs directly on the host as a systemd service and starts Agent
  deployments through the systemd runtime.
- Traefik forwards wildcard public Agent hosts to Gateway on port 4080. Agent
  processes remain private on `127.0.0.1:41xxx`.
- API and the host worker share `/var/lib/eveland` at the same absolute path for
  sources, releases, Collector configuration, and runtime state.

Complete the Linux host prerequisites in [`docs/deploy/linux.md`](docs/deploy/linux.md),
then set the public origins, Agent domain, and independent Gateway secrets in a
local `.env`:

```bash
# .env
WEB_ORIGIN=https://your-web-host
NEXT_PUBLIC_API_URL=https://your-api-host
BETTER_AUTH_URL=https://your-api-host
BETTER_AUTH_SECRET=<independent-long-random-auth-secret>
EVELAND_IDENTITY_ISSUER=https://your-api-host
EVELAND_IDENTITY_ALLOWED_ORIGINS=https://your-chat-host
EVELAND_IDENTITY_JWKS_URL=http://127.0.0.1:4000/.well-known/jwks.json
EVELAND_AGENT_BASE_DOMAINS=agents.example.com
EVELAND_GATEWAY_SERVICE_TOKEN=<long-random-service-secret>
EVELAND_GATEWAY_AFFINITY_SECRET=<independent-long-random-cookie-secret>
EVELAND_OTLP_SERVICE_TOKEN=<independent-long-random-collector-secret>
EVELAND_SCHEDULER_RUNTIME_SECRET=<independent-long-random-runtime-secret>
EVELAND_SCHEDULER_DISPATCH_SECRET=<independent-long-random-dispatch-secret>
EVELAND_SCHEDULER_REDEEM_URL=http://127.0.0.1:4000/internal/scheduler/dispatch
EVELAND_ADMIN_EMAIL=admin@example.com
EVELAND_ADMIN_PASSWORD=<strong-initial-password>
EVELAND_COOKIE_DOMAIN=.example.com
EVELAND_RELEASE_CHANNEL=stable
EVELAND_REVISION=<git-rev-parse-short-12-output>

# Start only the unprivileged control-plane services.
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

The base development Compose file contains a development `APP_SECRET_KEY`.
Before a real production deploy, replace it for the API through a site-specific
Compose override with a private 32-byte value, and configure that exact value in
the host worker. Do not use the checked-in development fallback in production.

The production overlay uses host networking so Gateway can reach systemd Agent
processes on host loopback. It runs the web production build and configures the
Compose services with `restart: unless-stopped`; it does **not** start the
containerized worker by default.

After configuring `infra/systemd/eveland-worker.env.example` for the same
database, data root, Agent domain, Gateway service token, and application secret
as the control plane, install and start the host worker:

```bash
sudo install -d -m 0750 /etc/eveland
sudo cp infra/systemd/eveland-worker.env.example /etc/eveland/eveland-worker.env
sudo cp infra/systemd/eveland-worker.service /etc/systemd/system/
# Edit /etc/eveland/eveland-worker.env before starting the service.
sudo systemctl daemon-reload
sudo systemctl enable --now eveland-worker
```

Use `infra/traefik/agents.yml` as the public wildcard routing template and keep
its `/internal` exclusion. For a legacy installation that still uses the Docker
runtime, the old containerized worker is available only through the explicit
`--profile docker-worker` Compose profile. See
[`docs/deploy/linux.md`](docs/deploy/linux.md) for host users, bubblewrap/AppArmor,
preflight, secrets, reverse-proxy, and smoke-test details.

When Web and API use sibling hosts, set `EVELAND_COOKIE_DOMAIN` to their shared parent
domain so the HttpOnly control-plane Session cookie reaches both services. Leave it
unset for localhost.

Agent projects accept Eveland Caller Tokens with `evelandIdentity()` from the
versioned `eveland/auth` SDK entry point under `packages/sdk`; see its
[README](packages/sdk/README.md).

## Versioning and releases

Eveland is a single SemVer-versioned product. API and Gateway `GET /health` report
`service: eveland`, their `component`, the product `version`, exact Git `revision`,
and release `channel`; Web compares its build with the API build in Settings > About.
Only `vX.Y.Z` tags are stable releases; `main` is the `edge` channel. Release Please
maintains the release PR, `CHANGELOG.md`, Git tag, and GitHub Release from
Conventional Commit history. The bubblewrap sandbox backend
[`@evelandhq/sandbox-bwrap`](https://github.com/evelandhq/sandbox-bwrap) ships from
its own repository on its own version line; the worker depends on it from npm and
vendors its built output into each release.

See [`docs/releases.md`](docs/releases.md) for the release policy, checklist, and
current artifact boundary, and [`docs/observability.md`](docs/observability.md) for
the observability architecture.

## Verification

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm lint       # oxlint; `pnpm lint:fix` applies safe fixes
pnpm fmt:check  # oxfmt; `pnpm fmt` rewrites in place (a pre-commit hook formats staged files)
# Requires a running local Docker engine; builds a fixture, starts the Agent,
# and proves a real HTTP turn can execute TypeScript through the bash tool.
pnpm --filter @evelandhq/worker smoke:docker-sandbox
# Requires Docker and openssl; verifies authenticated OpenAPI/MCP Connections,
# a directory-form subagent, restart, a second Release, and secret non-leakage.
EVELAND_RUNTIME=docker pnpm --filter @evelandhq/worker smoke:connections
# Requires Lima. Exercises the complete systemd/bwrap topology, including a
# dormant cron wake, Managed Connections, OTLP usage, idle stop, and continuation wake.
bash infra/integration/run.sh
```

## License

Eveland is licensed under the [GNU Affero General Public License v3.0](LICENSE).
The bubblewrap sandbox backend it depends on,
[`@evelandhq/sandbox-bwrap`](https://github.com/evelandhq/sandbox-bwrap), is a
separate project under the Apache License 2.0.
