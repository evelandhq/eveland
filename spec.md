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

### Login (/login)

The platform signs in with email and password; users, password accounts, and
sessions use Better Auth, and team members and invitations use the Organization
plugin. First startup idempotently creates a default admin; there is no built-in
production default password — the initial password and `BETTER_AUTH_SECRET` must be
configured explicitly. Except for health checks and invitation acceptance, every
platform API requires a valid member session; public Agent Gateway traffic uses an
independent authentication boundary. Better Auth's HTTP surface is exposed by
allowlist: only sign-in, sign-out, and get-session are publicly routable, every
other endpoint (including anything future versions add) is a 404, and password
changes and member management go through Eveland-owned endpoints.

The public `/health` of the API and Agent Gateway returns, beyond liveness, the
Eveland product `version`, Git `revision`, release `channel`, and current
`component`; all components share `service = eveland`, and the API, Dashboard,
Agent Gateway, and Worker must never be modeled as independently versioned
products.

### Agent user identity (/settings/identity)

Agent user identity, platform Better Auth, and Playground authentication
credentials are three independent trust boundaries; none may substitute for or
silently fall back to another. Better Auth cookies/tokens, member roles, and
provider credentials must never enter Caller Tokens, browser chat storage, the
Agent Gateway, or Agents.

The Identity Provider is instance-level and exactly one can be active at any time,
chosen from three: `Open` (the default for new instances; authenticates nobody and
issues no Identity Session), `Internal` (server-side verification of a Better Auth
member), and `OIDC` (delegation to an external OpenID Connect provider, with PKCE
and nonce forced on). The System Admin selects the single active provider, the
allowed Identity Realms, and the exact web-chat return origins; switching the
provider makes existing Identity Sessions authenticate no one.

Eveland issues only its own short-lived Caller Tokens (per-project audience) and
never passes through any provider credential. A Caller Token proves caller identity
only — access authorization belongs entirely to the Agent: "who may use which
Agent" is never Eveland configuration. Eveland holds only the instance-level
identity trust boundary via the Realm allowlist; there is no Realm → Project
access. Eveland itself must contain no provider-specific branch: provider verifiers
ship as external packages, and provider differences are expressed only through
generic protocol configuration.

`evelandIdentity()` works through the standard `WWW-Authenticate` Bearer challenge
protocol; the Agent Gateway must forward challenges, credentials, and responses
transparently, neither interpreting nor rewriting the protocol. The single
deliberate exception: when the Identity Provider is `Open`, the Agent Gateway
injects an open-mode Caller Token for requests carrying no `Authorization` at all,
and never overwrites an existing credential.

The standalone, public `GET /api/agent-catalog` serves the read-only Agent Catalog
projection: it requires no Identity Session, performs no authorization filtering,
probes no Agents, and is not a marketplace; `projectId` combined with the Eveland
issuer is the stable managed Agent identity, and an endpoint change must not mint a
new Agent identity.

Provider-mode behavior, Realm resolution, the Caller/App Token contracts, the
open-injection constraints, and the Catalog membership rules live in
`docs/en/reference/identity.md`; the decision rationale in
`docs/en/reference/design/identity.md`.

### Workspace and Settings pages

The Projects list is the workspace home; Settings is a separate settings area
grouped into Personal and System. Per-page columns, interactions, and limits live
in `docs/en/reference/dashboard.md`. The cross-page product invariants:

- Every absolute date and time in the Dashboard renders in the current user's
  display timezone, never decided by the server's runtime default timezone; a
  schedule's raw cron keeps its source-level UTC semantics.
- Project deletion is permanent and asynchronous: the full name is typed to
  confirm, the API atomically marks `deleting` and creates a unique
  `delete_project` job; on failure the record survives and supports idempotent
  retry. The platform must never delete external source paths outside
  `EVELAND_DATA_DIR`.
- Personal Git credentials are isolated per `(userId, host)` and cannot be reused
  by other members of the same team; no surface returns, copies, or hints at the
  PAT value.
- Team roles are only `admin` and `member`; the last admin can be neither removed
  nor demoted; invitation links are single-use and expire immediately on
  acceptance.
- About's runtime-configuration diagnostic uses an explicit allowlist and can never
  enumerate `process.env`; secrets show only configured/not-configured. The Worker
  adds no public HTTP service — its diagnostics reach the API through a masked
  snapshot file; an unreachable component shows unavailable, never falling back to
  reading raw environment files.
- The Eveland product version and a project's Release/Deployment are two
  independent concepts.

### Observability (/settings/observability)

Eveland's monitoring uses OpenTelemetry/OTLP as its only transport standard.
Built-in is the platform's always-on internal destination: it only projects
Eveland's existing operational data into the read models Sessions, Usage, and
Instance Health require — storing no raw spans/LogRecords/metric points, offering
no statistics views, and introducing no monitoring that did not already exist.
Span-level observation and drill-down belong to external destinations, and
observation of the platform's own telemetry likewise belongs entirely to external
destinations — Eveland provides no local fallback; Built-in retention is not
configurable.

The trust boundary is a product promise: the platform and Agents use OTLP receivers
that share no trust; deployment attribution is never taken from an Agent's
self-reported id but from Worker-issued credentials, whose verified identity
overrides the payload with the Store's ownership — resources with failed or missing
verification are neither projected nor sent externally. An Agent therefore cannot
forge platform state or write telemetry into another Deployment or Project; it can
still fabricate data under its own Deployment — resisting that requires provenance
granted by a trusted out-of-process boundary, which the current implementation does
not provide.

Instrumentation in Agent source is an independent boundary: Eveland does not modify
user monitoring code, register or replace global providers, or intercept user
exporters; the platform only injects the Eveland hook, with its private providers,
into Eve's reserved hook slot. Telemetry failures produce only rate-limited
degradation warnings and must never fail an Eve event hook or an Agent turn; a
missing Collector must not block Agent startup or cold activation; observability
settings changes restart only the Collector, never Agent Deployments. External
delivery goes only through the service-authenticated API egress proxy under a
fail-closed SSRF policy; credentials are stored encrypted and never returned to the
browser.

The collection-pipeline topology, destination behavior, projection and
out-of-order rules, and the retention table live in
`docs/en/reference/observability.md`.

### Instance Health (/settings/health)

Admin-only; presents "is it currently available" separately from "is it approaching
capacity risk". The Worker is the only privileged component collecting host
metrics: heartbeats and metric samples are sent as standard OTLP metrics in the
capacity domain, Built-in projects them, the API only reads and aggregates, and the
Dashboard displays read-only. A `stopped` RuntimeInstance is normal scale-to-zero
and must not alone be treated as a failure; the Worker heartbeat publishes
independently of long-running jobs. The page offers no shell, systemd restarts, or
any other host write operation; total server loss still requires external
monitoring polling the public `/health`. Display items and judgment rules live in
`docs/en/reference/dashboard.md`.

---

### New project (/new)

Creating a project uses a full-screen stepped flow supporting a Git repo URL and a
zip upload. The API first creates a user-isolated, expiring Source Preflight whose
real file tree and Eve project structure the worker validates — no project is
created yet; only a successful preflight reaches the naming screen. The project and
the initial import job consume the completed preflight in one database transaction,
and the same snapshot becomes the immutable Source Revision directly — no second
clone or re-upload; a failed import must not proceed to deployment.

The name confirmed at creation claims the immutable slug in the public Agent
address (instance-unique); a concurrent conflict returns 409 — silent renaming is
not allowed. The project also has a mutable display name and description whose
changes must never alter the slug, the public Agent endpoint, the project ID,
routes, or existing session/deployment relations.

The naming screen can record runtime Variables/Secrets before the first deploy;
the initial entries commit atomically with the project and the initial import job,
and values are stored encrypted and never returned to the browser. A private-repo
PAT serves only as temporary, normalized-host-scoped authentication — never
entering URLs, the source `.git/config`, logs, or errors — and is saved only after
the whole import succeeds.

Import and build are read-only toward the source: Source Revisions are immutable,
and Eveland's import, build, and deploy must not run `eve add`/`eve registry`,
reach the registry, or modify the source. Release builds must honor the project's
committed package-manager lockfile (frozen install), and the Docker and systemd
runtimes must make the same choice. `agent/skills/` is discovered and compiled
natively by Eve; the platform does not interpret `defineSkill` itself, and skill
scripts gain no extra host privileges or secrets through it.

Background jobs such as imports use leases and fencing: at most one running job per
project at a time, a late old attempt must never overwrite a newer attempt's state,
and an execution fenced off must abort its own host side effects; transient errors
retry within bounds, deterministic errors never retry. The Source Revision persists
the `package.json` and lockfile metadata needed to start an existing Release: cold
activation and schedule activation can recover the original deployment from that
metadata after the source directory is reclaimed, while restart stays
live-source-only.

Until Eve reaches a stable product-compatibility commitment, Eveland supports only
minor lines that have completed full compatibility verification; the window is a
set of verified lines, not a contiguous range, and every widening or narrowing of
the window is an explicit product change. The current window values, accepted
dependency-declaration forms, and per-line baselines live in
`docs/en/reference/eve-compatibility.md`.

A missing Eve dependency, or any declaration that could resolve outside the window,
must fail closed with a clear reminder to upgrade the project's `eve` dependency.
The check covers import, build, restart, cold activation, the Playground, and all
public Agent Gateway traffic reaching the selected deployment — it cannot be
bypassed through an old Source Revision, an old Deployment, or a SessionBinding,
and must never wake a dormant out-of-window Deployment; when a version cannot be
proven supported it is treated as unsupported, with no guessing and no
old-protocol compatibility. The UI marks the latest supported line in green and
older supported lines and out-of-window versions in red; still-supported older
lines keep running, out-of-window versions stay blocked.

The wizard interaction, PAT details, name format, `.env` import, preflight expiry,
and job execution semantics live in `docs/en/reference/source-import.md`.

---

### Project home and Deployments

Overview is the observation entry point: it defaults to the last seven days of
execution, and its primary action is Open Playground; full build, preview, traffic,
and rollback operations live in Project Deployments. The project sidebar orders
daily observation first, and Logs keeps an independent first-level entry.

The Deployments page offers exactly one `Create deployment` entry point; the dialog
composes two dimensions — Source (current revision, or sync Git first) and outcome
(keep as preview, or promote after health) — and the submit label must name the
combination explicitly, never using an ambiguous `latest` to mean both the current
revision and remote Git. Page details and the operation list live in
`docs/en/reference/dashboard.md`.

---

### Playground (/projects/proj_xxxxxxxxxx/playground)

Tests the current deployment directly. The Dashboard speaks the Eve canonical
session protocol to the current deployment through the API and the internal-only,
service-credentialed Agent Gateway Playground path; conversation, reasoning, tool
calls, and human input stream incrementally as NDJSON. The Agent Gateway never
substitutes for the Agent's own authentication and never stores, decrypts, or
refreshes provider credentials — credentials are resolved per request by the API
and delivered through a strictly validated versioned envelope.

Each managed project has at most one Playground authentication configuration. It is
the client configuration the Playground uses to call the Agent — not the project,
the deployment, an Eve Connection, or the platform login session; the user must
explicitly choose the client method, and the platform must never guess credential
acquisition from Eve verifier names, source imports, 401s, or `WWW-Authenticate`.
Credentials are stored encrypted and only their configured state is returned,
never the values.

Eveland adds no standalone Connections configuration page and does not take over
Eve's Connection definitions; official Eve Connections build with the Source
Revision and deploy with the Release, and project secrets inject at runtime only —
never readable at build time.

Every open or refresh of the Playground creates a fresh Eve session from a blank
state (`trigger = playground`); New conversation must complete a canonical session
reset before clearing the local conversation. Stopping generation must request
cooperative server-side cancellation through the canonical cancel route and keep
the stream open until settlement. The Playground transport does not replace
Eveland's private OTLP signals as the authoritative observation path; attachments
and raw reasoning are not persisted by the Playground.

The authentication method matrix, the OIDC client flow, credential storage and the
envelope, attachment limits, cancel/reconnect and catch-up-read stream semantics,
and the managed Connection validation matrix live in
`docs/en/reference/playground.md`.

---

### Sessions and Usage

Sessions is the core run history: the list shows only actual Eve sessions and never
mixes ScheduleRun execution envelopes in as peer rows; the detail shows Eve's event
timeline and per-agent/subagent usage, with no span tree or LogRecord detail —
Built-in stores no raw detail, and span-level drill-down belongs to external
destinations. Usage completeness is presented explicitly: missing usage and cost
stay missing, never estimated from public price lists, and steps whose model cannot
be resolved stay `Unknown model` — never dropped or guessed.

The Usage pages (workspace aggregate and single project) must aggregate server-side
over the full time range, never presenting page one of a paginated list as the
total; usage coverage and cost coverage are computed separately. Column
definitions, filters, and model-attribution rules live in
`docs/en/reference/dashboard.md`.

---

### Schedules (/projects/proj_xxxxxxxxxx/schedules)

Eveland is the sole scheduler for production schedules. A prepared Release keeps a
schedule's Eve registration shape but replaces the native cron handler with a
no-op — warm previews, older versions, and the stable target never each execute the
same cron; the real authored handlers are invoked only through the authenticated
private Scheduler Channel. Both root and Extension sources accept only five-field,
UTC, minute-granularity cron semantics, and a namespaced key conflict must fail the
build; `.eveland/scheduler/definitions.json` is a required, validated build
artifact.

Every Source Revision keeps an immutable ScheduleVersion; each project has an
explicit scheduler target, and cron/manual runs pin to the deployment, Release, and
ScheduleVersion fixed at creation — promote, rollback, or route-weight changes
never re-select them, and switching the target affects only runs created
afterwards.

The Worker treats Postgres as the authoritative state. An outage spanning multiple
ticks creates one run for the earliest due time and records the coalesced missed
ticks — no burst replay. Schedule execution is at-least-once: once a dispatch
credential is redeemed, authored side effects must never be replayed automatically
because a response was lost. A ScheduleRun settles on each returned session's root
turn boundary and releases its ActivationLease; when the boundary is permanently
missing it fails closed at the hard deadline, never showing `running` forever.
Queued/running ScheduleRuns give their pinned deployment hard reclamation
protection.

Schedule delivery must execute inside the platform-owned `scheduled` workflow run
context; authored options cannot loosen a schedule to `persistent`, and when a
delivery lands on an existing session, its stored root class wins.

Every cron or manual execution persists an independent ScheduleRun; success with no
created session is a legitimate result. Discovery and the build artifact, the
planner and prewarm, dispatch and settlement details, the Extension integrator, and
the page display rules live in `docs/en/reference/scheduling.md`.

---

### Source (/projects/proj_xxxxxxxxxx/source)

A read-only code browser: the file tree, file contents, current Source Revision
info, and the Eve project-structure summary. No online editing, no Git write-back;
Connections appear only as part of the structure summary, with no separate
Connections navigation or configuration UI. The built summary comes from the
discovery manifest of the final `eve info` on the installed dependency tree; only
versions produced by the current window are accepted, and unknown versions fail
closed while keeping the static summary. Summary fields and Extension projection
rules live in `docs/en/reference/source-import.md`.

---

### Project Settings (/projects/proj_xxxxxxxxxx/settings)

Project Settings uses in-page secondary navigation (General and Environment)
rather than a third sidebar level; General holds display name/description editing
and project deletion in its danger zone. Page details live in
`docs/en/reference/dashboard.md`.

### Variables and Secrets (/projects/proj_xxxxxxxxxx/settings/environment)

The Agent runtime environment has three layers with deterministic precedence:
Shared Agent Environment < project Secret/Variable < Eveland reserved variables.
Type distinguishes `variable` from `secret`; both value kinds are stored encrypted,
returning only the configured state after saving — values never return to the
browser.

Runtime entries are runtime configuration: after an add, change, or delete, the API
enqueues a restart task for each of the project's `running`/`draining` deployments;
the restart keeps the original Release and re-decrypts and injects the full set
when the new process starts. With no live deployment, entries take effect from the
next deploy. Project secrets inject at runtime only and never enter the Git repo,
the zip, the build log, the Source page, or session logs; variables are equally
absent from those places but additionally participate in Release builds.

### Shared Agent Environment (/settings/shared-agent-environment)

The system has exactly one operator-owned Shared Agent Environment (not a profile
collection), admin-maintained, applied automatically to every Agent deployment of
every project. A shared `secret` decrypts only at the process-start boundary and
reaches the runtime through a root-owned 0600 environment file — never appearing on
process argv or in any persisted artifact; the full value set participates in
diagnostic masking. The Shared Agent Environment belongs to the Agent runtime only
and must not serve as a Playground authentication credential; a missing, deleted,
or undecryptable secret reference must fail closed, never falling back to an old
value.

### Build-visible variables

`variable` entries participate in Release builds — values the agent config reads
from `process.env` at module-load time are frozen into the Release; `secret` never
enters a build, because install/build lifecycle scripts are untrusted project code.
Platform-reserved names are dropped from builds with a `WARNING` in the build log
(never silently), and the runtime reserved layer overrides same-named entries last;
the reserved list stays in sync with the runtime reserved layer, locked by a test.
Releases are immutable: changing a `variable` refreshes the compiled output only on
the next deploy, and a plain environment change only enqueues restarts for live
deployments.

Page interaction, bulk import, restart semantics, Shared Agent Environment details,
and the reserved list live in `docs/en/reference/agent-environment.md` and
`docs/en/production/worker.md`.

---

### Logs (/projects/proj_xxxxxxxxxx/logs)

Logs offers three log kinds — build, deploy, and runtime (stdout/stderr plus
ScheduleRun lifecycle diagnostics); an Agent's concrete execution belongs in the
session timeline, not in Logs. Page interaction lives in
`docs/en/reference/dashboard.md`.

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
   and observer hook are injected by the platform into the disposable Release
   copy; imported source, manifests, and lockfiles are never modified, and
   authored lifecycle and configuration must be preserved.
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
11. **The platform owns the cron clock.** Native cron handlers in a Release are
    no-ops; the sole scheduler pins every execution to the target fixed at
    creation.
12. **Observation never changes behavior.** Telemetry failures only degrade, never
    block; the Playground transport is not the authoritative observation path;
    Built-in only projects read models, leaving detail to external destinations.
13. **Version facts live outside the spec.** This spec carries no version numbers;
    widening or narrowing the compatibility window is an explicit product change,
    locked jointly by `docs/en/reference/eve-compatibility.md` and the
    architecture tests.

---

## 6. Runtime architecture

`apps/docs` is a public website independent of the self-hosted platform. The
production site is published at `https://eveland.ai`, a Next.js/Fumadocs app on
Cloudflare Workers; it shares no runtime privileges with the API, Agent Gateway,
worker, or Agent deployments. Merges to `main` touching `apps/docs/**` trigger CI
to build and publish the public site. This repository's own docs-publishing flow
does not change the product boundary that "imported Eve projects do not support
Git-push auto-deploy".

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

Every deployment owns an immutable Release, a preview host, and a runtime adapter,
but is not itself a permanently running process: a RuntimeInstance records one
generation of a container/unit, and a deployment may be `stopped` while remaining
addressable, continuable, and retention-protected. A project's stable host is a
mutable route; raw dynamic ports are not product URLs and are never exposed
publicly.

Build/deploy creates a concurrently running preview by default, never stopping
production; promote must explicitly target the exact deployment that job created.
The stable route can atomically point at one or at most two weighted targets;
session bindings beat route weights — while a SessionBinding/OperationBinding is
unexpired, continuation, cancel, stream, reset, and durable routes always return to
the original deployment, and an expired binding returns the stable `410`
`session_expired`, never re-running weights or landing on another deployment. When
one of two targets is unavailable, new sessions degrade to the sole healthy target;
only when both are unavailable does it return 503.

The Gateway never reclassifies an Agent's session-creation failure. When an initial
Eve response is a JSON 500 carrying an `errorId`, the Gateway may inspect only a
bounded clone for correlation, export that id with the platform request, Project,
Deployment, RuntimeInstance, and HMAC operation key, and add its reserved request-id
response header; the Agent's status and response bytes remain unchanged.

Activation is privilege-separated: the API only persists/waits on state and gains
no Docker or systemd privilege; the Worker is the only host controller, starting
the exact Release per the deployment's recorded `runtimeKind`. Every path touching
the process first acquires a bounded ActivationLease, with exactly one starter per
dormant deployment; after the last lease releases or expires the process stops
after an idle period, with a mandatory transactional re-check for new leases before
stopping. Readiness must prove port ownership: activation fails immediately when a
foreign process holds the port — never marking ready based on another process's
HTTP response; the listening port is a RuntimeInstance property, with a database
uniqueness constraint guaranteeing at most one live instance per port.

The Worker periodically runs archive and the orphan sweep: unprotected old
deployments archive idempotently through a claim state; unmanaged processes are
adopted or reaped per platform state — processes the platform has decided to stop
may only be reaped, never revived; the platform's own infrastructure containers are
never in scope. A failed health check must capture masked diagnostics before
cleanup, and diagnostics or cleanup failures may only append independent errors,
never overwriting the original one.

Host shapes, weight and binding rules, durable routes, activation and port
reservation, the orphan sweep, and diagnostics capture live in
`docs/en/reference/routing.md`.

Containers run the Eve project; the platform owns:

- Build and startup
- Health checks
- Secret injection
- Durable workflow world configuration, dependencies, and database schema
- Log collection
- Cron triggering
- Session source attribution
- Eveland's private OpenTelemetry signals
- Container restarts

The durable workflow world is a platform runtime contract, not an Agent source
contract: every new Release builds unconditionally against the shared
`@evelandhq/workflow-world`, with the worker force-injecting the platform-pinned,
Eve-compatibility-verified version — never requiring the Agent to declare a world,
and never modifying the imported snapshot, manifest, or lockfile. The world must
pass the World contract gate against each supported line's verified patch in the
current window (versions in `docs/en/reference/eve-compatibility.md`).

The runner mode supports only `external`; an explicit `embedded` is a configuration
error and must fail closed. Exactly one external dispatcher guarantees
single-instance operation via a lifetime advisory lock. Every Release persists an
immutable workflow attestation, and every start path decides solely on the
persisted attestation: legacy or `unknown` objects return managed errors with
stable prefixes and fail closed, never guessing from the current environment. In
production, both shared builds and `workflow_step` activation fail closed on the
freshness of the dispatcher's machine-readable registration.

The shared workflow uses `tenant_id` within one database as the mandatory query
boundary, with events and stream chunks partitioned per project; queues are claimed
only by the platform's external dispatcher, cold-start recovery must filter by
tenant, and project deletion drops only its own partitions — never scanning or
deleting another tenant's. The world is a build-time property of the Release and
cannot be swapped under a still-executing World by changing runtime environment
variables. The shared World assigns each new run's class through a single complete
retention policy chain, failing closed when lineage cannot be resolved;
`persistent` rows are never rewritten.

Attestation, bootstrap, dispatcher registration, storage boundaries, and retention
class details live in `docs/en/operations/runtime.md` and
`docs/en/production/workflow-dispatcher.md`.

An Eve deployment's built-in execution tools must connect to an executable isolated
sandbox — never silently degrading under production-style `eve start` to a
`just-bash` missing its optional peer. The platform injects
`@evelandhq/sandbox-bwrap` and replaces the user-authored sandbox backend while
preserving the authored lifecycle (`bootstrap()`, `onSession()`, `description`,
`revalidationKey`) and the `agent/sandbox/workspace/**` seeds. The durable session
workspace lives outside the Release directory — a redeploy/restart must not lose a
session's `/workspace` — and workspace templates are isolated per immutable
Release. After a Release build completes, the sandbox and the platform command
baseline must be self-checked under the actual runtime privileges — never just
checking file existence or trusting the health endpoint. Every deployment must
carry consistent memory, CPU, and process-count limits; a single `run()` has a hard
deadline, and long-lived authored processes must use `spawn()` under session
lifecycle management. Injection mechanics and workspace details live in
`docs/en/operations/runtime.md`; the rationale in
`docs/en/reference/design/sandbox.md`.

The code dependency boundary is fixed:

```text
apps -> packages
packages/db -> packages/core
packages/core -> depends on no other Eveland package
apps -X-> apps
```

`packages/core` separates contracts, the Eve wire protocol, and Node-only server
utilities through explicit subpaths, with no root barrel; the Drizzle schema,
migrations, and the single Postgres repository are held by `packages/db`.
Production uses real Postgres; ordinary tests run the same repository through
PGlite, while multi-connection locking, driver compatibility, and migration
integration tests still use real Postgres. The API and worker depend only on
packages and never import each other.

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
