# Eveland

Self-hosted control plane for importing, deploying, and observing `eve` projects.

## Current MVP Slice

- `packages/core`: dependency-free Eveland contracts plus explicit Eve protocol, ID, source, schedule, archive, secret, and runtime-command subpaths. It intentionally has no root barrel so browser-safe imports cannot accidentally pull in Node-only code.
- `packages/db`: Drizzle schema and migrations, one domain-oriented SQL Store used by production Postgres and PGlite tests, mappers, and the store factory shared by API and worker.
- `packages/sandbox-bwrap`: bubblewrap-based eve `SandboxBackend` giving agents deployed on the systemd runtime a real exec sandbox without Docker/KVM. The worker injects it into each eve project's release at build time — the deployed project never declares it (see `packages/sandbox-bwrap/README.md`).
- `packages/agent-observer`: release-time Eve hook injection for root and directory-form subagents. The injected hook owns private OpenTelemetry providers and never registers or mutates a user's global providers.
- `packages/agent-auth`: Node-only generic Agent Connection registry plus Authorization Code + PKCE OIDC acquisition, encrypted transaction/credential state, verification, refresh, and Basic/Bearer/Vercel-OIDC/custom-header materialization.
- `packages/identity-broker`: provider-neutral Agent-user identity finalization, separate Identity Sessions, short-lived project-audience ES256 Caller Token issuance, signing-key rotation, and public JWKS.
- `packages/platform-observability`: shared OpenTelemetry SDK bootstrap for Eveland API, Gateway, and Worker signals.
- `packages/session-collector`: standard OTLP JSON/protobuf decoding and projection into Eveland's built-in Session, usage, and instance-health read models.
- `apps/api`: Hono control-plane API with Better Auth email/password sessions and Organization-based team membership/invitations, plus the authenticated Built-in OTLP ingest endpoint. Its thin app entrypoint composes focused route modules; persistence is supplied by `packages/db`.
- `apps/gateway`: Host-routed public Agent data plane. It preserves Agent auth/cookies and streaming bodies, pins Eve sessions to deployments, and keeps raw Agent ports private. Pure Host/header/affinity/target rules are separated from request lifecycle orchestration.
- `apps/worker`: Docker and systemd runtime adapters, Postgres job consumer, and domain processors for import/build/restart/schedule job state transitions, with queue fencing kept separate from concrete job execution.
- `apps/web`: Next.js App Router control panel using the requested shadcn preset and Tailwind v4. Its account menu opens profile/password/display-timezone settings; every absolute timestamp and chart is rendered in that personal IANA timezone, defaulting to the browser's current timezone until saved. System settings owns member management, an About view for build/configuration diagnostics, and an admin-only Instance Health view for component reachability, host capacity trends, workload pressure, and disk-risk forecasting.
- `apps/docs`: Bilingual public website and documentation for `eveland.ai`, built with Next.js and Fumadocs. It keeps the marketing site separate from the authenticated control panel and publishes English and Chinese routes, search, sitemap, and `llms.txt`.

## Contributor Code Map

The main entrypoints are composers rather than homes for every implementation:

- Database contracts live in `packages/db/src/store-domains.ts`. Add behavior
  to the matching `postgres-*-store.ts` domain module; `postgres-store.ts`
  composes the public Store. Vitest uses the same Store through the PGlite
  helper exported by `@eveland/db/vitest`.
- API route families live in `apps/api/src/app-*-routes.ts`, request schemas in
  `app-schemas.ts`, and reusable protocol/request helpers in `app-support.ts`.
  `app.ts` owns cross-cutting auth services, middleware, and composition.
- Worker queue claiming, heartbeats, and terminal fencing live in
  `apps/worker/src/jobs/process.ts`. Import/build and runtime job execution are
  split across `process-job.ts` and `process-runtime-job.ts`; shared runtime,
  secret, filesystem, and networking helpers live in `process-support.ts`.
- Gateway request/response lifecycle handling lives in
  `apps/gateway/src/app.ts`; canonical Host validation, trusted forwarding
  headers, affinity cookies, and target selection live in
  `gateway-routing.ts`.
- The new-project screen keeps orchestration in
  `apps/web/src/components/new-project-flow.tsx`, with presentation and browser
  request helpers in adjacent `new-project-flow-*` modules.
- The docs global stylesheet imports focused marketing, documentation, and
  responsive stylesheets from `apps/docs/src/app` in cascade order.

Large test suites are split by behavior. Reuse colocated `*.test-support.ts`
fixtures rather than duplicating setup when adding coverage.

## Local Development

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env                  # set BETTER_AUTH_SECRET and EVELAND_ADMIN_PASSWORD
docker compose up -d postgres otel-collector # start the database and platform OTLP receiver
pnpm --filter @eveland/api db:migrate  # apply versioned migrations (required on first run and after schema changes)
pnpm dev                               # start API, Gateway, web, worker, and docs
```

Open the control panel at `http://localhost:3000` and the public documentation
site at `http://localhost:3001`.
The initial Admin email defaults to `admin@example.com`; its password comes only from
`EVELAND_ADMIN_PASSWORD` and must contain at least 12 characters.
`BETTER_AUTH_SECRET` is a separate random secret of at least 32 characters. `BETTER_AUTH_URL`
must be the browser-visible API origin (for example `https://api.example.com` in production).
Better Auth remains control-plane authentication only. System > Identity configures the
single active Agent-user Identity Provider, its allowed Identity Realm, and an exact web-chat
return origin. The Identity Broker creates a separate HttpOnly Identity Session and can issue
approximately 60-second, project-audience ES256 Caller Tokens; neither the Better Auth
session nor provider credentials are sent to the chat UI, Gateway, or Agent. Eveland uses
those tokens to authenticate a principal, while each Agent owns its business authorization.

`GET /agent-catalog` is a read-only projection of Stable routes whose positive-weight
Deployments all use an immutable Source Revision with an explicit standard `eveChannel`.
Scale-to-zero `stopped` targets remain discoverable. Catalog membership does not depend on an
Agent's auth helper or the reader's Identity Realm; the endpoint is public and returns the same
list to every caller. EveChats uses the Eveland issuer plus Project ID as the stable managed
identity and lazily creates a local connection only when an Agent is opened. It first calls the
Agent with its app-scoped credential. An `evelandIdentity()` route advertises a parameterized
Bearer challenge; only then does EveChats enter `/identity/login`, obtain a Caller Token, and
retry the original request. Other AuthFns, including Basic fallback in the same auth array,
remain Agent-owned. A separate `eveland:app:eve-chats` App Token protects EveChats-owned history
and external Agent data.

All four processes are required: the web form posts to the API, Playground/public Agent traffic goes through Gateway, and imports, builds, and deploys are executed by the worker's job polling — without it, projects stay pending after upload.

New projects start at `/new`, a focused full-screen flow for GitHub/GitLab URLs or Zip uploads. Before a Project exists, a user-scoped Source Preflight shallow-clones or safely extracts the source and has the worker verify the real Eve layout and supported Eve version. The naming step includes optional, repeatable environment variables for LLM keys and other runtime configuration; their values are encrypted and committed atomically with the Project and initial import job so the first deployment cannot start without them. The validated snapshot is then consumed with the exact public project name and reused for the first deployment without another clone or upload. Unused snapshots expire after one hour by default. The screen streams persisted progress logs, permits leaving for Project detail, and exposes the stable Agent URL when complete.
Authored Eve skills remain owned by Eve: `eve build` compiles flat Markdown, module-backed,
and packaged `agent/skills/` entries into Release workspace resources. Eveland's injected
sandbox materializes those resources under each Session's `$HOME/.agents/skills/`, so Eve's
built-in `load_skill` can load them without mapping the runtime back to the mutable source tree.
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
the job was queued. After deployment, Project Overview defaults to a seven-day execution
summary with Session volume, completion, usage, reported cost, recent Sessions, and the next
Schedule. Logs remain a direct first-level destination. Full release, preview, traffic,
rollback, and retention controls live under Project Deployments, while Source remains a
first-level code browser.

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

Docker Compose runs the full stack (Postgres + OpenTelemetry Collector + API + Gateway + web + worker) in **development mode**.
Only the worker receives the Docker controller socket; Gateway masks `.eveland-data` so the public
proxy cannot read imported project sources, Collector configuration, or encrypted project secrets.
The Collector mounts only `.eveland-data/otel` for its generated configuration and keeps its
persistent queues on a dedicated volume:

```bash
docker compose up
```

The service images are `node:24-alpine` with `git` / `docker-cli` / `unzip` installed at
startup — the app shells out to them for git import, agent deploy, and zip-upload extraction.
When the worker runs in Compose, `EVELAND_HOST_DATA_DIR` must be the host-absolute path
to the workspace's `.eveland-data`; this lets it atomically update the managed Collector
configuration and bind the same durable per-project sandbox cache into Deployment
containers across a restart or redeploy. The Docker adapter creates one telemetry
network per active Deployment, attaches only that Agent and the Collector, and
removes the network when the Deployment stops. The Worker reconnects a recreated
Collector to the surviving managed networks before telemetry resumes; Collector
absence degrades telemetry without blocking Agent activation. The orphan sweep
removes stale managed networks, while Docker startup preflight verifies that one
more bridge subnet can be allocated. Production Docker hosts must configure a
sufficient non-overlapping `default-address-pools` range as documented in
`docs/deploy/linux.md`.
New Git projects derive a globally unique, DNS-safe project slug from the repository name; explicit
names use lowercase letters, numbers, and hyphens, and collisions claim `-1`, `-2`, and so on atomically.
Public development endpoints use `http://<projectSlug>.agent.localhost:4080`; immutable previews use
`http://<eightCharacterDeploymentKey>--<projectSlug>.agent.localhost:4080`. Gateway validates the complete Host,
while deployment ports remain bound only to `127.0.0.1` and are not product URLs.

Imported Agents must declare an `eve` dependency wholly contained in verified `0.27.x`, `0.28.x`, or `0.29.x`. Eveland
fails closed during import, build, restart, cold activation, Playground, and public `/eve/v1/session` create, continue, cancel, reset, and stream traffic
when the dependency is missing, outside that line, or cannot be proven compatible; the diagnostic tells the
developer to upgrade instead of attempting an older Eve protocol. Project Overview, Source, and Playground show
the detected dependency version and the required lines. Until Eve publishes a stable compatibility contract,
this is a three-minor sliding window: a newly verified minor replaces the oldest line only after changelog/source review
and the complete compatibility matrix pass; an npm publication alone does not widen support. The checked-in matrix
currently verifies `0.27.13`, `0.28.0`, and `0.29.2`. Eve 0.27.2+ may open an NDJSON stream with a blank byte and lets
Client callers explicitly disable automatic reconnection; Eveland ignores blank lines, forwards stream bytes without
buffering, and keeps the default durable reconnect policy in Playground. Eve 0.27.4+ adds durable session reset;
Gateway persists continuation-token ownership so reset and token-only resume remain pinned across route changes,
then releases only that token binding after a successful reset. Eve 0.27.6 can explicitly forward principal metadata between
remote Agents, but Eveland does not enable trust on an Agent's behalf: sender and receiver must opt in with Eve's
`forwardPrincipal` and `trustedForwarders`, and credentials are never forwarded. Eve 0.27.3+ requires AI SDK
`ai@^7.0.34`; the platform workspace uses that peer-compatible range. Eve 0.27.7 adds bounded stream catch-up
through `follow: false`, `includeTailIndex=1`, and `x-eve-stream-tail-index`; Eveland transparently preserves the
query, response header, and NDJSON body across Web, API, and Gateway. Eve 0.29.2's registry commands are an
authoring-time CLI feature and do not expand a deployed Release's privileges or mutate imported sources.
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
Release gets its own workspace template revision: Sessions created against a newly deployed Release
use the updated seeds, while an existing durable Session keeps its current `/workspace` unchanged.

Pick one mode: either everything in Compose, or only `postgres` in Compose and the rest natively. The Compose services run `pnpm install` inside Linux containers against the mounted workspace, which clobbers a macOS-built `node_modules`.

## Production (single-box Linux deploy)

The current production topology deliberately separates the control plane from
the privileged runtime controller:

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

Agent projects accept Eveland Caller Tokens with `evelandIdentity()` from the
versioned `eveland/auth` SDK entry point under `packages/sdk`. The package is
buildable and packable independently, uses Eve as a peer dependency, and
projects opt in explicitly in their Eve channel auth walk. Eveland never
rewrites an Agent's public authentication boundary.

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
See [`docs/observability.md`](docs/observability.md) for the current
OpenTelemetry provider ownership, Collector trust boundaries, Built-in read
models, and external destination routing.

## Verification

```bash
pnpm test
pnpm typecheck
pnpm build
# Requires a running local Docker engine; builds a fixture, starts the Agent,
# and proves a real HTTP turn can execute TypeScript through the bash tool.
pnpm --filter @eveland/worker smoke:docker-sandbox
# Requires Lima. Exercises the complete systemd/bwrap topology, including a
# dormant Eve 0.27.x/0.28.x/0.29.x cron wake, OTLP usage, idle stop, and continuation wake.
bash infra/integration/run.sh
```

## License

Eveland is licensed under the [GNU Affero General Public License v3.0](LICENSE),
except for [`@eveland/sandbox-bwrap`](packages/sandbox-bwrap), which remains
licensed under the MIT License.

## Notes

- API, Gateway, and Worker require `DATABASE_URL` and use the same Postgres Store. Tests run that Store against migrated PGlite; concurrency and driver-compatibility suites continue to use real Postgres through `EVELAND_POSTGRES_TEST_URL`.
- The control plane is invite-only and uses Better Auth for users, credential accounts, and sessions. Team roles and seven-day invitations use its Organization plugin behind Eveland-owned endpoints, which enforce the last-admin rule and block public sign-up and direct organization mutations. Invitation links use opaque 256-bit identifiers. Public Agent traffic remains on the separate Gateway authentication boundary.
- `packages/db/src/schema.ts` and `packages/db/drizzle/` are the Postgres model and migration targets. Use `pnpm --filter @eveland/api db:migrate` for real databases; `db:push` is only a disposable-development convenience.
- Project deletion is asynchronous and requires the worker. A deletion request persists a visible `Deleting…` state, blocks new project mutations, waits for already-running project jobs, then stops every live Deployment and removes database records plus platform-managed source/build/observability-policy/sandbox data. Failures retain a retryable `Delete failed` state; source paths outside `EVELAND_DATA_DIR` are never removed.
- Eveland observability is OTLP end to end. Private providers injected into prepared Eve Releases export Agent telemetry to a dedicated Collector receiver; API, Gateway, and Worker use a separate service-authenticated platform receiver. The Agent receiver is reachable only over loopback or a Deployment-isolated Docker network shared solely by that Agent and the Collector, forces Agent resource identity, and drops scopes other than `@eveland/eve-runtime`. Because that receiver cannot authenticate its callers, each Deployment gets a Worker-signed credential delivered read-only with its runtime policy and carried on every private Agent signal. Built-in and the external-destination API proxy resolve the owning Deployment from that credential, replace Agent-supplied team/project/release/deployment identity with Store-owned values, and strip the credential before external delivery, so an Agent can neither claim another Deployment nor reach the platform receiver. It can still fabricate telemetry for itself — same-process provenance is outside this boundary.
- Built-in is always enabled but stores no raw spans, LogRecords, Metric Points, platform aggregates, delivery diagnostics, or trace tree. It receives only Agent logs and Worker capacity metrics, projects Sessions, provider-reported Usage, and Instance Health, and computes OTLP partial-success counts from the records actually consumed by those read models. Admins may additionally route every Eveland signal to Elastic, Agent traces to Langfuse, or selected signals/domains to a custom OTLP/HTTP destination.
- Each external exporter retains its own Collector retry and persistent queue, but sends through the service-authenticated API egress proxy rather than directly to the Admin-supplied URL. Destinations require HTTPS and public DNS by default; every request re-resolves and pins a validated address, does not follow redirects, and blocks private, loopback, link-local, and metadata addresses unless the exact host is explicitly allowlisted. Independent empty-OTLP probes expose destination health in System settings. Collector self-metrics go only to external destinations that accept platform metrics.
- The Langfuse preset accepts the installation base URL (for example, `https://us.cloud.langfuse.com`) and derives its signal-specific OTLP traces endpoint. It follows Langfuse's direct-OTLP v4 contract: model calls become generation observations; Agent, Tool, and Subagent operations remain span observations with filterable operation metadata; standard GenAI model/usage attributes and Collector-mapped provider cost stay on the original trace hierarchy.
- Session details show the projected root/child Eve conversation, events, and usage; span-level inspection remains the responsibility of a configured external destination. Telemetry emitted by source-owned instrumentation remains in the user's configured backend and is never adopted by Eveland.
- Built-in retention is a platform default, not an integration setting: capacity samples retain 30 days and derived Session/Usage data retains 90 days. There is no raw telemetry retention because Built-in does not store raw telemetry.
- Agent source instrumentation is not rewritten, adopted, or globally reconfigured. User providers and exporters continue to send exactly where the Agent configured them. System capture controls affect only Eveland's injected private provider and reload without restarting Agent Deployments. Private Provider flush and shutdown waits are capped at two seconds and degrade without failing the Eve hook or Agent turn.
- Token accounting uses Eve's provider-reported `step.completed.data.usage` values carried in standard OTLP LogRecords. Input, output, cache-read, cache-write, and optional gateway cost are attributed idempotently to the Eve session node that consumed them. Missing provider usage stays explicitly marked instead of being estimated.
- `/usage` and each Project's Usage page use the same server-side analytics contract for 24-hour, 7-day, and 30-day trends. They expose complete-range Session, token, cache, and reported-cost totals; separate usage and cost coverage; Project and Model breakdowns; Eve Agent × Model attribution; single-Model curves; and recent Session drill-down. Usage totals never reuse the paginated Session-list page as an aggregate.
- Playground is a fresh, single-conversation AI Elements UI on every page load. Follow-up turns, live reasoning, tool calls/results, HITL responses, and external-authorization prompts stay on one Eve session until the user starts a new conversation or leaves the page; both paths best-effort reset the durable Eve session before clearing browser state, and there is no session switcher. Stopping a supported Eve 0.27.x, 0.28.x, or 0.29.x turn requests cooperative server cancellation and leaves the event stream open through `turn.cancelled` and the following session boundary. Eve 0.26+ Clients follow durable streams from the last cursor across transient disconnects. Live raw reasoning and uploaded file bytes are not persisted by the Playground transport.
- Project Settings separates General from Environment. General can update a human-facing Display name and optional capability Description without changing the immutable public slug, Project ID, Agent endpoint, routes, or runtime relationships. Environment owns Project Variables and Secrets; the former `/projects/:projectId/secrets` route redirects there.
- Saving, editing, or deleting a Project Variable or Secret queues a targeted restart for every running or draining Deployment so stable, preview, and A/B targets cannot keep stale process environments. New-project setup and Project Settings > Environment can also paste or upload `.env` content, preview parsed values and invalid lines, classify each imported name as a Variable or Secret, and confirm new versus overwritten names before a single batch write; each live Deployment is restarted only once for that batch. Both value types are encrypted and never returned after saving. With no live Deployment, the entry is injected on the next deploy.
- Admins maintain one encrypted, revisioned Shared Agent Environment in System settings. It is injected automatically into every Agent Deployment with precedence Shared Agent Environment < Project Secret < Eveland-reserved values, so a Project can override a shared LLM key. Effective changes restart every running or draining Deployment; API/Web expose only keys, kinds, configured state, and revision, while values stay runtime-only and participate in diagnostic masking. Agent Connection credentials remain separate and reference only Project Secrets.
- Playground accepts up to four image, PDF, text, or code attachments per turn, limited to 5 MiB each and 10 MiB total; archives and executables are rejected. It does not collect or project usage. Eveland-injected OTLP telemetry discovers direct private-port, Playground, schedule, and child sessions independently, then merges more-specific provenance by `(projectId, eveSessionId)`.
- Canonical Playground create, continue, cancel, reset, and stream calls use Gateway's service-authenticated `/internal/projects/:projectId/playground/eve/*` path and stream responses without buffering. Traefik must expose only wildcard Agent hosts and exclude `/internal`; `infra/traefik/agents.yml` is the single-box example.
- Playground Agent route auth is configured explicitly through its Connection dialog. `local-dev` alone uses a loopback Host; `none`, Basic, Bearer, Vercel OIDC, custom headers, and generic OIDC use the canonical Project Host. Secret-bearing configuration selects a Project Secret instead of copying the value into Connection config. Vercel OIDC mirrors Eve 0.29.2 by sending its short-lived token as both Bearer authorization and the trusted deployment header. Eve 0.27 adds standards-compliant route challenges, including Basic realm/UTF-8 metadata, but Eveland still never infers a Connection method from a 401 challenge. Generic OIDC uses discovery, Authorization Code + PKCE, state/nonce, a Web-owned callback, encrypted principal-scoped tokens, explicit JWT/UserInfo verification, refresh-token rotation, singleflight, and Postgres fencing. Register `${WEB_ORIGIN}/agent-auth/oidc/callback` at the IdP. The first pending turn resumes exactly once after callback, a 401 gets at most one refresh/retry, and a 403 never refreshes. Web receives only redacted state, and API resolves the current reference plus security revision for every initial, continuation, cancel, reset, and stream/reconnect request. Eveland never infers a method from Agent source, provider name, or challenge, and the control-plane member id remains only a credential-isolation key rather than the Agent caller.
- Bare build/deploy creates a concurrent immutable preview and never stops or reuses the current production process. Project Deployments exposes one `Create deployment` dialog: choose the current immutable Source Revision or sync Git first, then keep the healthy Deployment as a preview or promote that exact Deployment to production. The current revision and production promotion are the defaults. Promote, rollback, and one/two-target traffic policies are atomic route updates followed by Gateway cache invalidation; live Eve session continuation, cancel, reset, and stream requests remain pinned by `SessionBinding` even after their target leaves production traffic. A successful bound request refreshes the binding's idle deadline. Playground bindings expire after 24 hours idle and public API bindings after 7 days idle by default; a later request for a known expired binding receives `410 session_expired` instead of being routed to another Deployment. A successful reset releases the continuation token while preserving the historical session/deployment binding.
- Route weights use 10,000 basis points, must total 10,000, and support at most two targets. Each multi-target policy revision becomes an experiment ID persisted with the deployment and variant binding, so the deployment page compares success/failure, latency, tokens, and cost without mixing revisions. Named aliases share the wildcard domain. Retention keeps at least the newest three release artifacts and refuses to archive mutable route targets, deployments with non-expired session bindings, or deployments protected by an active request lease. The Worker automatically archives older unprotected stopped Deployments and removes their runtime artifacts and build directories; failed builds are removed before they can become untracked disk usage.
- Eve 0.27.x, 0.28.x, and 0.29.x give directory-form subagents an independent hook slot, so they are fully observed. File-form subagents have no hook slot and their parent stream exposes only control events; they are a documented coverage gap until Eve exposes a public observation surface. Remote calls retain the reported URL as an unresolved relationship and are never followed by the collector.
- Docker and systemd Eve Releases both receive the injected bwrap backend and the same platform-owned command baseline. The release self-check exercises file writes, Node 24 TypeScript execution, every baseline command, and Eve's real `rg`/GNU-grep search paths rather than trusting `/eve/v1/health`, which does not initialize Eve's sandbox.
- A failed initial health check captures Docker state/restart count and recent container logs, or systemd unit state and recent journal output, before cleanup. Runtime diagnostics are masked with the Project's Secret values and capped at 32,000 characters; diagnostic or cleanup failures never replace the original deploy error.
- Eveland owns production cron execution for Eve 0.27.x, 0.28.x, and 0.29.x Markdown and TypeScript schedules. The release adapter fails closed on every Eve dependency that can resolve outside that three-minor window. It accepts strict five-field, minute-resolution UTC cron, coalesces missed ticks into one run with a count, and pins each run to the scheduler-target Deployment/Release/ScheduleVersion selected when the run is created. Promotion affects only future runs. Prepared Releases neutralize Eve's native cron handlers and expose authored definitions only through a private authenticated Scheduler Channel, preventing every warm preview or old Release from independently executing business logic. The Worker uses durable `nextRunAt` values to keep a scheduler target warm or proactively wake it during `EVELAND_SCHEDULER_PREWARM_MS` (60 seconds by default), without executing the handler early.
- Schedule runs emit searchable Runtime Logs for pinned-target activation, Scheduler Channel dispatch, and completion, including the ScheduleRun ID and elapsed time. A dispatch that returns Session IDs remains `running` until Built-in projects the root turn boundary from private OTLP logs for every returned Session; zero-Session dispatches complete immediately. Dispatch timeouts preserve the configured timeout and Deployment context instead of exposing only a generic abort message; credentials and Project Secrets are never included.
- Sessions lists only Eve Sessions in start-time order. Schedules pairs each raw five-field UTC expression with a human-readable recurrence and owns the paginated recent ScheduleRun history; a one-Session run links directly to that Session, while zero- and multi-Session runs retain their dedicated detail view. Scheduled Session details show the compact run provenance without duplicating the full execution inspector.
- Deployment identity and process lifetime are separate. A durable Deployment can be `stopped` while its immutable Release, preview Host, routes, and SessionBindings remain. Cron, public requests, continuations, and streams acquire ActivationLeases; API coalesces a service-authenticated wake request, the Worker starts the exact Release with its persisted runtime adapter, and Gateway waits up to `EVELAND_COLD_START_TIMEOUT_MS` (30 seconds by default). After the final lease, the Worker stops the process after `EVELAND_ACTIVATION_IDLE_TTL_MS` (5 minutes by default) without deleting the Deployment. Upcoming and non-terminal ScheduleRuns protect their pinned target from idle reaping. A dispatched run holds that protection until all returned Sessions reach a turn boundary, the exact RuntimeInstance disappears, or `EVELAND_SCHEDULE_RUN_MAX_RUNTIME_MS` (24 hours by default) expires; activation waits through a bounded `draining` transition before creating the next RuntimeInstance generation.
- Durable workflow is platform-owned. The worker bootstraps the workflow Postgres schema at startup, wraps the root config only in the prepared Release to force `@workflow/world-postgres`, and installs the pinned compatible world package outside the project's manifest and lock. Agent source does not need to mention the world or its dependency and is never rewritten.
- Set `WORKFLOW_POSTGRES_URL` to the address used by deployed Agents (Compose uses `host.docker.internal`). If the worker reaches the same database through another address, set `WORKFLOW_POSTGRES_BOOTSTRAP_URL` (Compose uses the `postgres` service name). When the deployment URL uses `host.docker.internal` and otherwise exactly matches `DATABASE_URL`, the worker automatically uses that already-reachable control-plane URL for bootstrap; an explicit bootstrap URL still wins. `WORKFLOW_POSTGRES_URL` is reserved and cannot be overridden by a Project Secret. A production worker fails fast without it; development without it keeps Eve's local world. `NODE_ENV=production` is also injected into deployments.
