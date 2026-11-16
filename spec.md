# Eveland Product Specification

> This file is Eveland's product and architecture contract: it constrains product
> boundaries, architectural invariants, and trust boundaries only — it describes no
> implementation detail and carries no version facts. The per-domain behavioral
> contracts are authoritative in `docs/en/reference/` (mirrored by `docs/zh`), and
> each section ends with a pointer; the currently supported Eve version window and
> the platform-injected workflow world version live in
> `docs/en/reference/eve-compatibility.md`.

## 1. Positioning

Eveland is a self-hosted web application for importing, configuring, running, and
observing standard Eve (https://eve.dev, https://github.com/vercel/eve) projects.

A user imports an Eve project as a Git repo or a zip upload, configures its runtime
environment, and can then deploy and test it directly, and inspect its session run
history, logs, and schedule definitions.

---

## 2. User journey

```text
Sign in
  → Project list
  → New project
  → Import a Git repo or upload a zip
  → Validate the Eve project structure
  → Configure the secrets the run needs
  → Build & Deploy
  → Run it directly in the Playground
  → Inspect Sessions, Schedules, Logs
```

---

## 3. Core objects

```text
Team
  ├─ Members / Invitations
  └─ Project
      ├─ Source Revision
      │   └─ Git commit / uploaded zip snapshot
      ├─ Release
      │   └─ the artifact of one build
      ├─ Deployment
      │   └─ a Release running now
      ├─ Secrets
      │   └─ platform-held, never written back to code or the repo
      ├─ Sessions
      │   └─ Eve's actual run history
      └─ Schedules
          └─ cron definitions in the Eve project
```

Only one default environment exists today: `Production`.
Each Eveland instance has exactly one Team; the data model keeps the boundary needed
to support multiple Teams later.

---

## 4. Product contract

Each domain below states only the invariants that bound it. Page layout,
columns, interactions, and limits live in `docs/en/reference/dashboard.md`; every
other behavioral detail lives in the reference page named at the end of each
domain.

### Platform authentication

- Sign-in is email and password. Better Auth owns users, password accounts, and
  sessions; its Organization plugin backs the single Team's members and
  invitations. First startup idempotently creates the admin, and there is no
  built-in default password: the initial password and `BETTER_AUTH_SECRET` are
  configured explicitly.
- Except for health checks, invitation acceptance, and the CLI device-authorization
  endpoints, every platform API requires a valid member session or a scoped CLI
  access token. Public Agent traffic uses its own, independent boundary.
- Better Auth's HTTP surface is exposed by allowlist (sign-in, sign-out,
  get-session, and the device-authorization family); every other endpoint,
  including any a future version adds, is a 404. Password changes, member
  management, and password resets go through Eveland-owned endpoints.
- The `eveland` CLI authenticates with the standard device-authorization flow: a
  signed-in member explicitly approves or denies the request, and the CLI redeems
  an opaque, expiring, revocable token confined to a deny-by-default scope map
  (deployment delivery and read-only observation). A CLI token never reaches
  member administration or the operator surface, whatever the approving member's
  role, and unauthenticated device-code creation is admission-controlled. The one
  exception to interactive approval is `eveland-ctl` first boot: the bootstrap,
  which just seeded the admin and holds its credentials, approves its own device
  request over the loopback API. That changes who approves, not the trust model;
  the token is an ordinary scoped, revocable device-flow token.
- The CLI and the platform are compatible when they share a major version. The
  CLI names its version on every request, and the platform refuses a CLI of
  another major version before running anything, with an error that names the
  version to install.
- Team roles are only `admin` and `member`; the last admin can be neither removed
  nor demoted; invitation links are single-use and expire on acceptance; removing
  a member revokes their sessions immediately.
- The public `/health` of the API and Agent Gateway reports the Eveland product
  `version`, Git `revision`, release `channel`, and `component`. All components
  share `service = eveland`: the API, Dashboard, Agent Gateway, and Worker are
  never independently versioned products, and the product version is independent
  of any project's Releases and Deployments.

Reference: `docs/en/reference/dashboard.md`, `docs/en/reference/cli.md`.

### Agent user identity

- Agent user identity, platform Better Auth, and Playground credentials are three
  independent trust boundaries; none substitutes for or silently falls back to
  another. Better Auth cookies and tokens, member roles, and provider credentials
  never enter Caller Tokens, browser chat storage, the Agent Gateway, or Agents.
- Exactly one instance-level Identity Provider is active: `Open` (the default;
  authenticates nobody), `Internal` (a Better Auth member), or `OIDC` (an external
  OpenID Connect provider, PKCE and nonce forced on). Switching it makes existing
  Identity Sessions authenticate no one.
- Eveland issues only its own short-lived, per-project Caller Tokens and never
  passes a provider credential through. A Caller Token proves who is calling;
  deciding who may use which Agent belongs to the Agent and is never Eveland
  configuration. The platform holds only the instance-level Realm allowlist.
- Eveland contains no provider-specific branch: provider differences are generic
  protocol configuration, and provider verifiers ship as external packages.
- The Agent Gateway forwards `WWW-Authenticate` challenges, credentials, and
  responses untouched. Its single exception: under `Open`, it injects a Caller
  Token into a request that carries no `Authorization` at all, and never replaces
  one that does.
- The public `GET /api/agent-catalog` is a read-only projection: no Identity
  Session, no authorization filtering, no probing of Agents. `projectId` with the
  Eveland issuer is a managed Agent's stable identity; an endpoint change never
  mints a new one.

Reference: `docs/en/reference/identity.md`; rationale in
`docs/en/reference/design/identity.md`.

### Workspace and settings

- Every absolute date and time in the Dashboard renders in the viewer's display
  timezone, never the server's; a schedule's cron keeps its own timezone.
- Project deletion is permanent and asynchronous, confirmed by typing the full
  name; a failed deletion keeps the record and can be retried idempotently. The
  platform never deletes source paths outside `EVELAND_DATA_DIR`.
- Personal Git credentials are isolated per `(userId, host)`, are never reused by
  another member, and no surface returns, copies, or hints at a PAT.
- About's runtime-configuration diagnostic uses an explicit allowlist, never
  enumerates `process.env`, and shows secrets only as configured or not. The Worker
  adds no public HTTP service; an unreachable component shows as unavailable and
  is never diagnosed by reading raw environment files.
- Instance Health is admin-only, separates "available now" from "approaching
  capacity risk", and offers no host write operation. The Worker is the only
  component that collects host metrics, as OTLP metrics that Built-in projects; a
  `stopped` RuntimeInstance is normal scale-to-zero, not a failure; total server
  loss still needs external monitoring of the public `/health`.

Reference: `docs/en/reference/dashboard.md`.

### Source import

- A project is created only from a completed Source Preflight: the worker
  validates the real file tree and Eve project structure first, and the project,
  its initial import job, and the immutable Source Revision come from that one
  snapshot in one transaction. A failed import never proceeds to deployment.
- The name confirmed at creation claims the project's immutable,
  instance-unique slug; a conflict is a 409, never a silent rename. Display name
  and description never change the slug, endpoint, project ID, routes, or existing
  relations.
- Variables and Secrets entered at creation commit atomically with the project. A
  private-repository PAT is temporary, host-scoped authentication that never
  enters URLs, `.git/config`, logs, or errors, and is saved only after the import
  succeeds.
- Import and build are read-only toward the source: they never run `eve add` or
  `eve registry`, never reach the registry, and never modify the source. Builds
  honor the committed lockfile with a frozen install, identically on every runtime.
  `agent/skills/` is Eve's to discover and compile; skill scripts gain no host
  privileges or secrets through the platform.
- Background jobs use leases and fencing: at most one running job per project, a
  late attempt never overwrites a newer one, and a fenced-off execution aborts its
  own host side effects. Transient errors retry within bounds; deterministic ones
  never retry.
- Eveland hosts one Eve major, from its first stable release up to the newest
  minor it has verified. The floor never moves within the major, and raising the
  ceiling is an explicit product change. A project's declared `eve` must be able to
  resolve inside the window, and the build gates on the version it actually
  installed; every Release is inside the window by construction.

Reference: `docs/en/reference/source-import.md`,
`docs/en/reference/eve-compatibility.md`, `docs/en/reference/known-limitations.md`.

### Deployments and routing

- Build and deploy create a concurrent preview and never stop or reuse the
  production target. Promote targets the exact Deployment a job created.
- Creating a deployment states its source (current revision or a fresh Git sync)
  and its outcome (preview, or promote after health) explicitly; nothing uses an
  ambiguous "latest".

Reference: `docs/en/reference/routing.md`, `docs/en/reference/dashboard.md`.

### Playground

- The Playground speaks Eve's canonical session protocol to a Deployment through
  the API and the Agent Gateway's internal, service-authenticated path, streaming
  NDJSON. The Agent Gateway never substitutes for the Agent's authentication and
  never stores, decrypts, or refreshes provider credentials; the API resolves them
  per request into a strictly validated, versioned envelope.
- Each project has at most one Playground authentication configuration: the
  client configuration the Playground uses to call the Agent, chosen explicitly
  and never guessed from verifier names, imports, 401s, or `WWW-Authenticate`.
  Credentials are stored encrypted and only their configured state is returned.
- Eveland adds no Connections configuration and does not take over Eve's
  Connection definitions; they build with the Source Revision and deploy with the
  Release.
- Every open or refresh starts a fresh Eve session; New conversation completes a
  canonical reset first; Stop requests cooperative server-side cancellation. The
  Playground transport is never the authoritative observation path, and it
  persists no attachments or raw reasoning.

Reference: `docs/en/reference/playground.md`.

### Sessions and usage

- Sessions lists only actual Eve sessions, never ScheduleRun envelopes as peer
  rows. Its detail shows Eve's event timeline and per-agent usage, never a span
  tree or LogRecords.
- Missing usage and cost stay missing, never estimated from price lists; a step
  whose model cannot be resolved stays `Unknown model`.
- Usage aggregates server-side over the full range, never presenting one page of
  a list as a total; usage coverage and cost coverage are separate.

Reference: `docs/en/reference/dashboard.md`, `docs/en/reference/observability.md`.

### Schedules

- Eveland is the only scheduler. eve's own schedule runner is off in every
  Deployment, so no schedule runs twice across previews, older Deployments, and
  the stable target; authored schedules, left as written, run only through the
  authenticated private Scheduler Channel. A namespaced key conflict fails the
  build, and `.eveland/scheduler/definitions.json` is a required, validated build
  artifact.
- Every Source Revision keeps an immutable ScheduleVersion. Cron and manual runs
  pin to the Deployment, Release, and ScheduleVersion fixed when they are created;
  promote, rollback, weight changes, and target changes never re-select them.
- Postgres is the authoritative state. An outage spanning several ticks creates
  one run and records the missed ticks; there is no burst replay. Execution is
  at least once, but a redeemed dispatch credential is never replayed. A
  ScheduleRun settles on its sessions' root turn boundary, fails closed at its hard
  deadline when the boundary never comes, and protects its pinned Deployment from
  reclamation while queued or running.
- Schedule delivery runs in the platform-owned `scheduled` workflow class, which
  authored options cannot loosen.

Reference: `docs/en/reference/scheduling.md`.

### Agent environment

- An Agent's environment has three layers with deterministic precedence: Shared
  Agent Environment < project Variables and Secrets < Eveland reserved variables.
  Values are stored encrypted, decrypted only at process start, delivered through
  a root-owned `0600` file, and never returned to the browser.
- Changing an entry restarts the project's live Deployments onto their existing
  Releases. `variable` entries also take part in builds and reach compiled output
  only on the next deploy; `secret` entries never enter a build, because build
  scripts are untrusted project code. Reserved names are dropped from builds with
  a logged warning, and the reserved layer always wins at run time.
- The Shared Agent Environment is a single admin-owned set applied to every
  Deployment. It is never a Playground credential, and a missing or undecryptable
  secret reference fails closed instead of falling back to an old value.

Reference: `docs/en/reference/agent-environment.md`.

### Model Gateway

- At most one admin-configured Model Gateway (LiteLLM, OpenRouter, Vercel AI
  Gateway, or a generic OpenAI-compatible endpoint), distinct from the Agent
  Gateway. When one is configured and a project has not opted out, the platform
  supplies the default AI SDK provider for string model IDs, so an Agent written
  with plain `provider/model` slugs runs unchanged on Vercel and on Eveland.
- The platform never overrides a provider the Agent installed, never affects
  model objects, never rewrites model IDs, and holds no gateway credential: each
  project brings its own key in `AI_GATEWAY_API_KEY`.
- A deploy fails when the gateway rejects the project's key or does not offer one
  of its string models. Gateway-reported cost is recorded; a gateway that reports
  none leaves cost missing.

Reference: `docs/en/reference/model-gateway.md`; rationale in
`docs/en/reference/design/model-gateway.md`.

### Observability

- OpenTelemetry/OTLP is the only telemetry transport. Built-in is always on and
  only projects the read models Sessions, Usage, and Instance Health need; it
  stores no raw spans, LogRecords, or metric points, and its retention is not
  configurable. Span-level drill-down and observation of the platform's own
  telemetry belong to external destinations.
- Deployment attribution never comes from what an Agent reports: Worker-issued
  credentials are verified and the Store's ownership overrides the payload, and
  unverified resources are neither projected nor exported. An Agent cannot write
  telemetry into another Deployment or Project; it can still fabricate data under
  its own Deployment, which only an out-of-process provenance boundary could
  prevent.
- User instrumentation is untouched: Eveland registers or replaces no global
  provider and intercepts no user exporter; it only injects its hook and
  instrumentation, with private providers, into Eve's reserved slots.
- Telemetry failures degrade with rate-limited warnings and never fail an Eve
  hook, an Agent turn, startup, or cold activation. Observability settings restart
  only the Collector. External delivery goes through the service-authenticated API
  egress proxy under a fail-closed SSRF policy, with credentials stored encrypted
  and never returned to the browser. Collector-to-API delivery never needs the API
  on a public interface.

Reference: `docs/en/reference/observability.md`.

### Logs

Logs holds build, deploy, and runtime output (stdout/stderr and ScheduleRun
lifecycle diagnostics). An Agent's execution belongs in its session timeline, not
in Logs.

Reference: `docs/en/reference/dashboard.md`.

---

## 5. Architecture principles

Constraints that span every domain. Violating any of them is an architecture
decision change — discuss first, then act:

1. **Fail closed.** When compliance cannot be proven — version window, workflow
   attestation, dispatcher registration, secret reference, manifest version —
   reject with an actionable diagnostic; no guessing, no silent degradation, no
   old-protocol compatibility.
2. **Immutable artifacts.** Source Revisions, Releases, workflow attestations, and
   ScheduleVersions are immutable once written; only routing and configuration are
   mutable. Release immutability means environment changes can only restart onto
   the original Release, and compile-time inputs take effect only on the next
   deploy.
3. **A single privileged component.** Only the Worker holds host privileges
   (Docker/systemd); the API only persists and waits on state, the Agent Gateway
   only forwards traffic, and the Dashboard displays read-only.
4. **Bindings beat weights.** Route weights apply only to new sessions; once a
   session/operation binding exists, promote, rollback, or weight changes never
   move existing conversations, and an expired binding fails explicitly instead of
   re-routing.
5. **Secrets flow one way.** Stored encrypted, decrypted only at the process-start
   boundary, delivered via a root-owned 0600 file; never back to the browser,
   logs, telemetry, argv, builds, or any persisted artifact; diagnostics show only
   the configured state.
6. **Platform injection, source-oblivious.** The sandbox backend, workflow world,
   observer hook and instrumentation, and Model Gateway default provider (inert until a gateway is
   configured) are injected by the platform into the disposable Release copy;
   imported source, manifests, and lockfiles are never modified, and authored
   lifecycle and configuration — including a model provider the Agent installs
   itself — must be preserved.
7. **A transparent proxy.** The Agent Gateway neither interprets nor rewrites the
   Agent's authentication protocol or response bytes; the single deliberate
   exception is Open mode injecting a Caller Token for credential-less requests,
   never overwriting an existing credential.
8. **The platform authenticates; Agents authorize.** Eveland only issues and
   verifies its own identity credentials; "who may use which Agent" is always the
   Agent's business logic, never platform configuration.
9. **Provider neutrality.** Provider differences in identity and credentials are
   expressed only through generic protocol configuration; provider-specific code
   lives outside the platform.
10. **At-least-once plus idempotence.** Background jobs use leases and fencing; a
    side-effect credential, once redeemed, is never replayed automatically;
    telemetry projection advances idempotently by event sequence and never
    regresses state on replay.
11. **The platform owns the cron clock.** eve's own schedule runner is off in
    every Deployment; the sole scheduler pins every execution to the target
    fixed at creation.
12. **Observation never changes behavior.** Telemetry failures only degrade, never
    block; the Playground transport is not the authoritative observation path;
    Built-in only projects read models, leaving detail to external destinations.
13. **Version facts live outside the spec.** This spec carries no version numbers;
    raising the compatibility window's ceiling is an explicit product change,
    locked jointly by `docs/en/reference/eve-compatibility.md` and the
    architecture tests.

---

## 6. Runtime architecture

```text
Browser
  ↓
Eveland Dashboard
  ↓
Platform API
  ├─ Source import
  ├─ Build
  ├─ Secret injection
  ├─ Built-in OTLP ingest and Session provenance
  └─ Schedule trigger
  ↓
Public Agent Gateway (stable/preview Host routing)
  ↓
Eve Deployment (127.0.0.1 private upstream)
```

The platform owns build and startup, health checks, secret injection, the
durable workflow world, log collection, cron triggering, session attribution,
Eveland's private OpenTelemetry signals, and restarts. The Agent's code is the
imported Eve project, unchanged.

### Deployments, routing, and activation

- A Deployment owns an immutable Release, a preview host, and the runtime adapter
  recorded as its `runtimeKind`. It is not a permanently running process: a
  RuntimeInstance records one generation of a unit or container, and a `stopped`
  Deployment stays addressable, continuable, and retention-protected. Raw ports
  are private upstreams, never product URLs.
- The stable route points at one target or at most two weighted targets.
  Unexpired SessionBindings and OperationBindings always return continuation,
  cancel, stream, reset, and durable routes to their original Deployment; an
  expired binding answers `410 session_expired` and never re-runs the weights. A
  binding never moves. When one of two targets is unavailable, new sessions go to
  the healthy one; only when both are unavailable does the Agent Gateway answer
  `503`.
- The Agent Gateway never reclassifies an Agent's failure: it may inspect a
  bounded clone of an initial JSON `500` for its `errorId` and correlate it, but
  the Agent's status and bytes pass through unchanged.
- The API only persists and waits on state; the Worker is the only host
  controller and starts the exact Release with the adapter its `runtimeKind`
  names. Every path that touches a process holds a bounded ActivationLease, a
  dormant Deployment has exactly one starter, and a process stops after an idle
  period only after a transactional re-check for new leases. Readiness proves port
  ownership; at most one live RuntimeInstance holds a port.
- Archive and the orphan sweep are idempotent; a process the platform decided to
  stop is only ever reaped, never revived, and the platform's own infrastructure
  containers are never in scope. A failed health check captures masked
  diagnostics before cleanup, and later failures never overwrite the original
  error.

Reference: `docs/en/reference/routing.md`.

### Durable workflows

- The durable workflow world is a platform runtime contract, not an Agent source
  contract: every Release is built against the shared `@evelandhq/workflow-world`
  at the version the platform pins, without the Agent declaring a world and without
  touching the imported snapshot, manifest, or lockfile.
- Runs are dispatched only by the one external Workflow Dispatcher per
  installation, which holds a lifetime advisory lock. Every Release persists an
  immutable workflow attestation, and every start path decides from it alone; a
  Release without one fails closed. In production, builds and `workflow_step`
  activation also fail closed on a stale dispatcher registration.
- `tenant_id` is the mandatory query boundary in the one shared database. Only the
  dispatcher claims queues, cold-start recovery filters by tenant, and project
  deletion drops only its own partitions. The world is a build-time property of
  the Release, never swapped by changing runtime environment variables. Each new
  run's retention class comes from one policy chain that fails closed when lineage
  cannot be resolved; `persistent` rows are never rewritten.

Reference: `docs/en/operations/runtime.md`; rationale in
`docs/en/reference/design/workflow.md`.

### Sandbox and resources

- An Eve Deployment's built-in execution tools always connect to a real isolated
  sandbox. The platform injects `@evelandhq/sandbox-bwrap` and runs every sandbox
  the Agent builds on it, preserving the authored sandbox preparation, selector,
  and `agent/sandbox/workspace/**` seeds; a Release in which a sandbox escapes the
  injection is refused at build time.
- A session's `/workspace` lives outside the Release directory and survives
  redeploys and restarts; workspace templates are isolated per Release. After a
  build, the sandbox and the platform command baseline are self-checked under the
  real runtime privileges.
- Every Deployment carries consistent memory, CPU, and process-count limits, and
  every sandboxed command, a long-running `spawn()` included, has a hard
  wall-clock and output limit.

Reference: `docs/en/operations/runtime.md`, `docs/en/agents/sandbox.md`; rationale
in `docs/en/reference/design/sandbox.md`.

### Code boundaries

`packages/core` holds shared contracts and the Eve wire protocol behind explicit
subpaths, with no root barrel; `packages/db` holds the schema, migrations, and the
single Postgres Store, which ordinary tests run through PGlite. Apps depend only on
packages and never on each other. The full dependency matrix lives in
`AGENTS.md` and is enforced by `packages/architecture-tests`.

`apps/docs` is the public website at `https://eveland.ai`, published from `main`
to Cloudflare Workers. It shares no runtime privileges with the platform, and
publishing it does not change the product boundary that imported Eve projects do
not deploy on Git push.

---

## 7. Non-goals

Eveland currently does not do:

- An online code editor
- GitHub OAuth / automatic sync
- Git-push auto-deploy
- Multi-environment management
- Custom domains
- Multi-region deployment
- Kubernetes
- A team permission system
- A Connection marketplace
- Complex billing and metering
- workerd / isolate runtimes
- A fully multi-tenant sandbox

---

## 8. Tech stack

- Frontend: Next.js, TypeScript, Tailwind/shadcn
  (`shadcn@latest init --preset bJxy4cpE --base base --template next`), system
  default fonts with `antialiased` enabled on `body`
- Backend: Hono, Better Auth, Drizzle ORM, PostgreSQL
- IDs generated with
  `nanoid('1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ')`
