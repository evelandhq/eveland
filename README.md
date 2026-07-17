# Eveland

Self-hosted control plane for importing, deploying, and observing `eve` projects.

## Current MVP Slice

- `packages/core`: dependency-free Eveland contracts plus explicit Eve protocol, ID, source, schedule, archive, secret, and runtime-command subpaths. It intentionally has no root barrel so browser-safe imports cannot accidentally pull in Node-only code.
- `packages/db`: Drizzle schema and migrations, Postgres repository, memory repository, mappers, and store factory shared by API and worker.
- `packages/sandbox-bwrap`: bubblewrap-based eve `SandboxBackend` giving agents deployed on the systemd runtime a real exec sandbox without Docker/KVM. The worker injects it into each eve project's release at build time — the deployed project never declares it (see `packages/sandbox-bwrap/README.md`).
- `packages/agent-observer`: release-time Eve hook injection for root and directory-form subagents. Hooks write durable envelopes without importing Eveland runtime code.
- `packages/session-collector`: filesystem outbox claim/lease recovery, validation, ingestion, and Session/usage projection.
- `apps/api`: Hono control-plane API with Better Auth email/password sessions and Organization-based team membership/invitations, plus an embedded observer collector. Persistence is supplied by `packages/db`.
- `apps/gateway`: Host-routed public Agent data plane. It preserves Agent auth/cookies and streaming bodies, pins Eve sessions to deployments, and keeps raw Agent ports private.
- `apps/worker`: Docker and systemd runtime adapters, Postgres job consumer, and worker processors for import/build/restart/schedule job state transitions.
- `apps/web`: Next.js App Router control panel using the requested shadcn preset and Tailwind v4. Its account menu opens profile/password settings; System settings owns member management and an About view that compares Web/API build identity and gives admins a masked, component-aware runtime configuration diagnostic.
- `apps/docs`: Bilingual public website and documentation for `eveland.ai`, built with Next.js and Fumadocs. It keeps the marketing site separate from the authenticated control panel and publishes English and Chinese routes, search, sitemap, and `llms.txt`.

## Local Development

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env                  # set BETTER_AUTH_SECRET and EVELAND_ADMIN_PASSWORD
docker compose up -d postgres          # start the database
pnpm --filter @eveland/api db:migrate  # apply versioned migrations (required on first run and after schema changes)
pnpm dev                               # start API, Gateway, web, worker, and docs
```

Open the control panel at `http://localhost:3000` and the public documentation
site at `http://localhost:3001`.
The initial Admin email defaults to `admin@example.com`; its password comes only from
`EVELAND_ADMIN_PASSWORD` and must contain at least 12 characters.
`BETTER_AUTH_SECRET` is a separate random secret of at least 32 characters. `BETTER_AUTH_URL`
must be the browser-visible API origin (for example `https://api.example.com` in production).

All four processes are required: the web form posts to the API, Playground/public Agent traffic goes through Gateway, and imports, builds, and deploys are executed by the worker's job polling — without it, projects stay pending after upload.

New projects start at `/new`, a focused full-screen flow for GitHub/GitLab URLs or Zip uploads. Before a Project exists, a user-scoped Source Preflight shallow-clones or safely extracts the source and has the worker verify the real Eve layout and supported Eve version. The naming step includes optional, repeatable environment variables for LLM keys and other runtime configuration; their values are encrypted and committed atomically with the Project and initial import job so the first deployment cannot start without them. The validated snapshot is then consumed with the exact public project name and reused for the first deployment without another clone or upload. Unused snapshots expire after one hour by default. The screen streams persisted progress logs, permits leaving for Project detail, and exposes the stable Agent URL when complete.
The public docs process is independent of that control-plane path. Use
`pnpm dev:api`, `pnpm dev:gateway`, `pnpm dev:web`, `pnpm dev:worker`, and
`pnpm dev:docs` in separate terminals when isolated logs are more useful.

Git imports run non-interactively and time out after 120 seconds by default. Set
`EVELAND_GIT_CLONE_TIMEOUT_MS` on the worker to tune that limit for slow networks.
Set `EVELAND_SOURCE_PREFLIGHT_TTL_MS` on the API to change the default one-hour lifetime
of an unconsumed source check; the worker removes expired managed snapshots.
Transient network failures retry up to three times with exponential backoff. Running jobs
renew a generic lease; stale jobs are re-queued after a worker crash, and attempt fencing
prevents a late worker from overwriting the recovered job's terminal status.
The Project page follows the asynchronous import job until completion and exposes a
credential-redacted failure with a retry action; an accepted create/sync request only means
the job was queued.

Private GitLab imports, including self-managed hosts, can provide a PAT with the minimal
`read_repository` scope next to an HTTPS repository URL. The API encrypts it with
`APP_SECRET_KEY`; the worker scopes temporary Git HTTP authentication to the exact normalized
host and never writes the token into the clone URL or imported repository. A PAT becomes a
personal saved host credential only after the source import succeeds. Later imports and syncs
by the same user automatically reuse it, while Settings > Git credentials can list hosts or
remove a credential without ever revealing its value.

## Public docs deployment

`apps/docs` is deployed as the `eveland-docs` Cloudflare Worker at
`https://eveland.ai` through the OpenNext adapter. Build or preview the Worker
runtime locally with:

```bash
pnpm --filter @eveland/docs build:cloudflare
pnpm --filter @eveland/docs preview:cloudflare
```

The `Deploy docs` GitHub Actions workflow deploys after a push to `main` only
when the pushed changes include `apps/docs/**`. It requires the repository
secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`; the token should be
scoped to Workers edits for the account and zone that own `eveland.ai`.
`apps/docs/wrangler.jsonc` owns the Worker name and custom-domain binding, so
the Cloudflare account must have an active `eveland.ai` zone before deployment.

Docker Compose runs the full stack (Postgres + API + Gateway + web + worker) in **development mode**.
Only the worker receives the Docker controller socket; Gateway masks `.eveland-data` so the public
proxy cannot read imported project sources, observer outboxes, or encrypted project secrets:

```bash
docker compose up
```

The service images are `node:24-alpine` with `git` / `docker-cli` / `unzip` installed at
startup — the app shells out to them for git import, agent deploy, and zip-upload extraction.
When the worker runs in Compose, `EVELAND_HOST_DATA_DIR` must be the host-absolute path
to the workspace's `.eveland-data`; this lets deployment containers bind the same observer
outbox that the API's embedded collector reads and the same durable per-project sandbox
cache that survives a Deployment restart or redeploy.
New Git projects derive a globally unique, DNS-safe project slug from the repository name; explicit
names use lowercase letters, numbers, and hyphens, and collisions claim `-1`, `-2`, and so on atomically.
Public development endpoints use `http://<projectSlug>.agent.localhost:4080`; immutable previews use
`http://<eightCharacterDeploymentKey>--<projectSlug>.agent.localhost:4080`. Gateway validates the complete Host,
while deployment ports remain bound only to `127.0.0.1` and are not product URLs.

Imported Agents must declare an `eve` dependency wholly contained in the verified `0.24.x` line. Eveland
fails closed during import, build, restart, cold activation, Playground, and public `/eve/v1/session` traffic
when the dependency is missing, outside that line, or cannot be proven compatible; the diagnostic tells the
developer to upgrade instead of attempting an older Eve protocol. Project Overview, Source, and Playground show
the detected dependency version and the required line.
Release builds also preserve the imported project's dependency resolution: `pnpm-lock.yaml` selects a frozen
pnpm install, `package-lock.json` selects `npm ci`, and an unlocked project falls back to `npm install`. The same
selection is used by Docker and systemd, including the platform-owned workflow-world dependency, so a pnpm
project is never re-resolved through npm's peer-dependency rules.

Local Docker Deployments receive the same injected `@eveland/sandbox-bwrap` backend as
systemd Deployments. Their generated image includes bubblewrap plus the platform sandbox
toolchain (`bash`, Node 24/`npm`, `pnpm` 11.7.0, `rg`, GNU `grep`/`find`, `git`, `curl`,
`jq`, Python 3/`pip`, `unzip`, and `zstd`), creates the required `/workspace` mountpoint,
and runs a build-time self-check before the Release can succeed. The check writes and
executes a typed Node file, verifies every command, and exercises both Eve's preferred
`rg` search and its GNU `grep --exclude-dir` fallback. The Agent container drops Docker's
default capabilities, adds only `SYS_ADMIN` and `NET_ADMIN` for nested bwrap, and uses
`no-new-privileges`; it never receives the Docker socket. These relaxed outer-container
seccomp settings are for the local-development Docker runtime. Production continues to use
the unprivileged systemd+bwrap topology documented below. Existing Releases are immutable,
so redeploy a project once after upgrading to pick up the toolchain.
When an Eve project includes `agent/sandbox/workspace/**`, release preparation preserves those
authored seeds and generates the platform backend as `agent/sandbox/sandbox.js`, so Eve still
materializes the files under `/workspace` for each new Session. Authored sandbox `bootstrap()`
and `onSession()` behavior is replaced because Eveland owns the deployment backend. Each immutable
Release gets its own workspace template revision: after Sync & Deploy, newly created Sessions use
the updated seeds, while an existing durable Session keeps its current `/workspace` unchanged.

Pick one mode: either everything in Compose, or only `postgres` in Compose and the rest natively. The Compose services run `pnpm install` inside Linux containers against the mounted workspace, which clobbers a macOS-built `node_modules`.

## Production (single-box Linux deploy)

The current production topology deliberately separates the control plane from
the privileged runtime controller:

- Postgres, API, Gateway, and web run through Docker Compose.
- Worker runs directly on the host as a systemd service and starts Agent
  deployments through the systemd runtime.
- Traefik forwards wildcard public Agent hosts to Gateway on port 4080. Agent
  processes remain private on `127.0.0.1:41xxx`.
- API and the host worker share `/var/lib/eveland` at the same absolute path for
  sources, releases, and observer outboxes.

Complete the Linux host prerequisites in [`docs/deploy/linux.md`](docs/deploy/linux.md),
then set the public origins, Agent domain, and independent Gateway secrets in a
local `.env`:

```bash
# .env
WEB_ORIGIN=https://your-web-host
NEXT_PUBLIC_API_URL=https://your-api-host
BETTER_AUTH_URL=https://your-api-host
BETTER_AUTH_SECRET=<independent-long-random-auth-secret>
APP_SECRET_KEY=<private-32-byte-agent-auth-and-project-secret-key>
JINSHUJU_OIDC_ISSUER=https://account.example.com
JINSHUJU_OIDC_CLIENT_ID=<jinshuju-oauth-client-id>
JINSHUJU_OIDC_CLIENT_SECRET=<jinshuju-oauth-client-secret>
JINSHUJU_OIDC_SCOPES="openid profile"
EVELAND_AGENT_BASE_DOMAINS=agents.example.com
EVELAND_GATEWAY_SERVICE_TOKEN=<long-random-service-secret>
EVELAND_GATEWAY_AFFINITY_SECRET=<independent-long-random-cookie-secret>
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
OIDC clients must register
`$WEB_ORIGIN/agent-auth/oidc/callback`
as an exact redirect URI. That URL is a Web page: it receives the authorization
response, immediately scrubs it from the address bar, and submits it to API with
the existing Better Auth session so the grant is bound to the initiating Eveland
member without equating that member with the IdP subject. The registered
redirect URI therefore never depends on how the API is mounted or proxied.

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
`--profile docker-worker` Compose profile; it is not the default production
topology. See [`docs/deploy/linux.md`](docs/deploy/linux.md) for host users,
bubblewrap/AppArmor, preflight, secrets, reverse-proxy, and smoke-test details.

When Web and API use sibling hosts, set `EVELAND_COOKIE_DOMAIN` to their shared parent domain
so the HttpOnly control-plane Session cookie reaches both services. Leave it unset for localhost.

## Versioning and releases

Eveland is a single SemVer-versioned product beginning at `0.1.0`. API and
Gateway `GET /health` responses report `service: eveland`, their `component`,
the product `version`, exact Git `revision`, and release `channel`. API,
Gateway, and Worker print the same identity at startup. Web shows
`Eveland vX.Y.Z` in the sidebar and compares its Web build with the API build in
Settings > About. Admins also see the allowlisted effective configuration for
Web, API, Gateway, and Worker there. Secret values are never returned, database
and service URLs have credentials and query values removed, Gateway diagnostics
stay behind its service-authenticated internal route, and Worker publishes only
an already-masked snapshot under the shared `EVELAND_DATA_DIR`.

Only `vX.Y.Z` tags are stable releases. `main` is the `edge` channel and must be
identified by its commit SHA. Release Please maintains the release PR,
`CHANGELOG.md`, Git tag, and GitHub Release from Conventional Commit history;
the root product version does not force private workspace packages or the
independently published MIT `@eveland/sandbox-bwrap` package onto the same
version.

The current production topology still runs a tagged source checkout rather
than immutable Eveland service images. See [`docs/releases.md`](docs/releases.md)
for the exact policy, release checklist, token requirement, channel semantics,
and current artifact boundary.

## Verification

```bash
pnpm test
pnpm typecheck
pnpm build
# Requires a running local Docker engine; builds a fixture, starts the Agent,
# and proves a real HTTP turn can execute TypeScript through the bash tool.
pnpm --filter @eveland/worker smoke:docker-sandbox
# Requires Lima. Exercises the complete systemd/bwrap topology, including a
# dormant Eve 0.24.x cron wake, observer usage, idle stop, and continuation wake.
bash infra/integration/run.sh
```

## License

Eveland is licensed under the [GNU Affero General Public License v3.0](LICENSE),
except for [`@eveland/sandbox-bwrap`](packages/sandbox-bwrap), which remains
licensed under the MIT License.

## Notes

- API uses Postgres when `DATABASE_URL` is set; tests use the memory store.
- The control plane is invite-only and uses Better Auth for users, credential accounts, and sessions. Team roles and seven-day invitations use its Organization plugin behind Eveland-owned endpoints, which enforce the last-admin rule and block public sign-up and direct organization mutations. Invitation links use opaque 256-bit identifiers. Public Agent traffic remains on the separate Gateway authentication boundary.
- `packages/db/src/schema.ts` and `packages/db/drizzle/` are the Postgres model and migration targets. Use `pnpm --filter @eveland/api db:migrate` for real databases; `db:push` is only a disposable-development convenience.
- Project deletion is asynchronous and requires the worker. A deletion request persists a visible `Deleting…` state, blocks new project mutations, waits for already-running project jobs, then stops every live Deployment and removes database records plus platform-managed source/build/observer/sandbox data. Failures retain a retryable `Delete failed` state; source paths outside `EVELAND_DATA_DIR` are never removed.
- Token accounting uses Eve's `step.completed.data.usage` values. Injected hooks write envelopes to `$EVELAND_DATA_DIR/observer`; the API's embedded collector validates and projects them exactly once. Input, output, cache-read, cache-write, and optional gateway cost are attributed to the Eve session node that consumed them. Missing provider usage stays explicitly marked instead of being estimated.
- Playground is a fresh, single-conversation AI Elements UI on every page load. Follow-up turns, live reasoning, tool calls/results, HITL responses, and external-authorization prompts stay on one Eve session until the page is reloaded; there is no session switcher. Live raw reasoning and uploaded file bytes are not persisted by the Playground transport.
- Every managed Agent has an Agent Connection that selects how Playground obtains Eve Route Auth credentials. Imports and Playground Connection settings use the server method registry (`local-dev`, `none`, Basic, static Bearer, custom credential headers, OIDC, or Jinshuju OIDC). On the first import only, an actual `jinshujuOidc(...)` call in an Eve channel automatically selects the server-managed Jinshuju method; an import alone does not, later syncs do not overwrite a member's setting, and generic 401 responses are never used to guess a method. API and Worker read Jinshuju OAuth values from `JINSHUJU_OIDC_*` when creating or saving that Connection, then encrypt the standard OIDC config in the same database record used by other methods; changing the environment does not mutate an existing Connection until it is saved again. OIDC uses Authorization Code with PKCE. This client-side Agent Connection is unrelated to Eve tool/connection auth.
- OIDC Route Auth uses discovery, Authorization Code with PKCE S256/state/nonce, encrypted principal-scoped tokens, fenced refresh, and at most one retry after a 401. The `audience` field selects how access tokens are verified: with an audience the token must be a JWT accepted by Eve `verifyOidc` (audience-binding providers such as Okta or Auth0 with an API identifier), and the value is also sent as the RFC 8707 `resource` parameter; leave it blank for providers that issue opaque access tokens without audience binding — the token is then verified against the issuer's UserInfo endpoint, including the OIDC Core 5.3.2 subject check against the ID token. The first protected turn is retained in browser session storage before redirect and claimed once after callback; the Agent receives no session request until authorization succeeds. The Eveland member id only isolates the grant and is never compared with or sent as the Agent's OIDC subject.
- Saving, replacing, or deleting a Project Secret queues a targeted restart for every running or draining Deployment so stable, preview, and A/B targets cannot keep stale process environments. With no live Deployment, the Secret is injected on the next deploy. The Secrets page reports which case applies; wait for the queued restarts before testing in Playground.
- Playground accepts up to four image, PDF, text, or code attachments per turn, limited to 5 MiB each and 10 MiB total; archives and executables are rejected. It does not collect or project usage. Observer envelopes discover direct private-port, Playground, schedule, and child sessions independently, then merge more-specific provenance by `(projectId, eveSessionId)`.
- Canonical Playground session calls use Gateway's service-authenticated `/internal/projects/:projectId/playground/eve/*` path and stream responses without buffering. Traefik must expose only wildcard Agent hosts and exclude `/internal`; `infra/traefik/agents.yml` is the single-box example.
- For authenticated Playground calls, API decrypts and resolves a request credential, then sends a strictly validated versioned envelope over that same internal path. Gateway applies loopback authority only for `local-dev`; every other method uses the canonical Agent Host. Public callers cannot forge the envelope, and Gateway never stores or refreshes credentials.
- Build/deploy creates a concurrent immutable preview and never stops or reuses the current production process. Promote, rollback, and one/two-target traffic policies are atomic route updates followed by Gateway cache invalidation; existing Eve sessions remain pinned by `SessionBinding` even after their target leaves production traffic.
- Route weights use 10,000 basis points, must total 10,000, and support at most two targets. Each multi-target policy revision becomes an experiment ID persisted with the deployment and variant binding, so the deployment page compares success/failure, latency, tokens, and cost without mixing revisions. Named aliases share the wildcard domain. Retention keeps at least the newest three release artifacts and refuses to archive mutable route targets or deployments with active session bindings.
- Eve 0.24.x gives directory-form subagents an independent hook slot, so they are fully observed. File-form subagents have no hook slot and their parent stream exposes only control events; they are a documented coverage gap until Eve exposes a public observation surface. Remote calls retain the reported URL as an unresolved relationship and are never followed by the collector.
- Docker and systemd Eve Releases both receive the injected bwrap backend and the same platform-owned command baseline. The release self-check exercises file writes, Node 24 TypeScript execution, every baseline command, and Eve's real `rg`/GNU-grep search paths rather than trusting `/eve/v1/health`, which does not initialize Eve's sandbox.
- A failed initial health check captures Docker state/restart count and recent container logs, or systemd unit state and recent journal output, before cleanup. Runtime diagnostics are masked with the Project's Secret values and capped at 32,000 characters; diagnostic or cleanup failures never replace the original deploy error.
- Eveland owns production cron execution for Eve 0.24.x Markdown and TypeScript schedules. The release adapter fails closed on every Eve dependency that can resolve outside 0.24.x. It accepts strict five-field, minute-resolution UTC cron, coalesces missed ticks into one run with a count, and pins each run to the scheduler-target Deployment/Release/ScheduleVersion selected when the run is created. Promotion affects only future runs. Prepared Releases neutralize Eve's native cron handlers and expose authored definitions only through a private authenticated Scheduler Channel, preventing every warm preview or old Release from independently executing business logic. The Worker uses durable `nextRunAt` values to keep a scheduler target warm or proactively wake it during `EVELAND_SCHEDULER_PREWARM_MS` (60 seconds by default), without executing the handler early.
- Deployment identity and process lifetime are separate. A durable Deployment can be `stopped` while its immutable Release, preview Host, routes, and SessionBindings remain. Cron, public requests, continuations, and streams acquire ActivationLeases; API coalesces a service-authenticated wake request, the Worker starts the exact Release with its persisted runtime adapter, and Gateway waits up to `EVELAND_COLD_START_TIMEOUT_MS` (30 seconds by default). After the final lease, the Worker stops the process after `EVELAND_ACTIVATION_IDLE_TTL_MS` (5 minutes by default) without deleting the Deployment. Upcoming and non-terminal ScheduleRuns protect their pinned target from idle reaping, and activation waits through a bounded `draining` transition before creating the next RuntimeInstance generation.
- Durable workflow is platform-owned. The worker bootstraps the workflow Postgres schema at startup, wraps the root config only in the prepared Release to force `@workflow/world-postgres`, and installs the pinned compatible world package outside the project's manifest and lock. Agent source does not need to mention the world or its dependency and is never rewritten.
- Set `WORKFLOW_POSTGRES_URL` to the address used by deployed Agents (Compose uses `host.docker.internal`). If the worker reaches the same database through another address, set `WORKFLOW_POSTGRES_BOOTSTRAP_URL` (Compose uses the `postgres` service name). When the deployment URL uses `host.docker.internal` and otherwise exactly matches `DATABASE_URL`, the worker automatically uses that already-reachable control-plane URL for bootstrap; an explicit bootstrap URL still wins. `WORKFLOW_POSTGRES_URL` is reserved and cannot be overridden by a Project Secret. A production worker fails fast without it; development without it keeps Eve's local world. `NODE_ENV=production` is also injected into deployments.
