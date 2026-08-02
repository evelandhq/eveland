# AGENTS.md

This file applies to the entire repository. It is working guidance for coding
agents; product behavior still belongs in the product and deployment docs.

## Start here

Before changing code:

1. Read `docs/spec.md` for the product contract.
2. Read `README.md` for the current repository shape and local workflow.
3. For Linux, systemd, sandbox, or host-worker work, also read
   `docs/deploy/linux.md`.
4. For Gateway, routing, or versioned Deployment work, read the relevant
   decisions in
   `docs/superpowers/plans/2026-07-13-gateway-observability-handoff.md`.
5. For observability work, read `docs/observability.md`.
6. Inspect the implementation, nearby tests, and `git status` before proposing
   or making changes.

`docs/spec.md` is the product truth source. Tests and current code are the truth
for implemented behavior. If they conflict, identify the conflict explicitly;
do not silently make the implementation, spec, and operational docs disagree.

## How to work in this repository

- Ground plans and explanations in the actual files, data flow, event shapes,
  database state, logs, and runtime behavior. Do not guess an endpoint or
  protocol when it can be inspected.
- For a bug report, reproduce or inspect the real failing path before changing
  code. Prefer the narrowest failing test that captures the defect.
- For a feature or bug fix, add or update tests first, observe the relevant
  failure, implement the smallest coherent change, and then broaden
  verification.
- Pure deletion is an exception to the test-first rule. When a feature or code
  path is no longer part of the product contract and leaves no supported
  compatibility, migration, security, or runtime boundary, delete the
  implementation and its obsolete tests directly; no red-green cycle or
  replacement test is required.
- Do not add tombstone tests that only assert a deleted file, export, method,
  field, route, component, string, or configuration option is absent. A
  negative test must protect durable current behavior such as authorization,
  validation, data isolation, secret handling, fail-closed protocol behavior,
  or an explicitly supported upgrade/compatibility path, and should exercise
  observable behavior rather than implementation absence.
- Finish a requested vertical slice across contracts, persistence, API, worker,
  UI, examples, and docs where those surfaces are affected. A compilable
  scaffold alone is not a finished feature.
- Keep changes focused. Preserve pre-existing or unrelated worktree changes and
  do not include generated noise such as incidental `apps/web/next-env.d.ts`
  rewrites.
- Prefer staged migrations over global default flips. Keep compatibility and
  rollback behavior explicit at runtime and data boundaries.
- Do not commit, push, open a PR, or rewrite history unless the user asks. If
  publication is requested, carry it through the requested commit/push/PR or
  post-merge sync workflow and report the resulting branch or PR state.

## Commit messages and releases

Releases are automated by release-please, which parses Conventional Commits on
`main` to build the changelog and compute the next version. Write every commit
message and PR title in Conventional Commits format:

- `feat: ...` for user-facing features (minor bump).
- `fix: ...` for bug fixes (patch bump).
- `feat!: ...` or a `BREAKING CHANGE:` footer for breaking changes (major
  bump).
- `chore: ...`, `docs: ...`, `refactor: ...`, `test: ...`, `ci: ...` for
  everything else; these do not affect the version.

Non-conventional messages are silently skipped by release-please: they never
appear in the changelog and do not influence the version. Prefer squash-merging
PRs with a conventional title so `main` history stays parseable.

Merging a normal PR to `main` never publishes a release; it only updates the
pending `chore(main): release X.Y.Z` PR. Merging that release PR is the
deliberate act that tags and publishes a release, and it is a user decision —
do not merge it on your own.

## Repository map and dependency direction

The workspace uses Node.js 24+, pnpm 11, TypeScript, and Vitest.

- `apps/web`: authenticated Next.js App Router control panel.
- `apps/docs`: bilingual public website and Fumadocs documentation, separate
  from the authenticated control panel.
- `apps/api`: Hono control-plane API, Better Auth/team host, and Built-in OTLP
  ingest. `app.ts` composes focused route, schema, and support
  modules.
- `apps/gateway`: public Agent data plane and internal privileged Playground
  path. Request lifecycle orchestration is separate from pure routing rules.
- `apps/worker`: import, build, deployment, restart, scheduling, health, and
  runtime-controller jobs, split between queue orchestration, concrete job
  families, and shared runtime helpers.
- `packages/core`: shared contracts and domain logic, split into explicit
  browser-safe and Node-only subpath exports.
- `packages/db`: Drizzle schema, migrations, repositories, mappers, and one
  domain-oriented SQL Store used by production Postgres and PGlite tests.
- `packages/agent-observer`: release-time Eve hook injection with private
  OpenTelemetry providers that do not modify user provider registration.
- `packages/platform-observability`: shared OpenTelemetry SDK bootstrap for
  Eveland services.
- `packages/session-collector`: standard OTLP projection into Eveland
  Session, usage, and instance-health read models.
- `packages/sandbox-bwrap`: the systemd runtime's Eve exec sandbox backend.
- `packages/architecture-tests`: the ratchet suite that enforces this file's
  dependency direction and the workspace-wide structural rules (see
  "Architecture ratchets" below).
- `packages/agent-auth`: Agent Connection auth providers, OIDC, and the sealed
  config/credential envelopes.
- `packages/identity-broker`: Agent-user Identity realms, sessions, and Caller
  Token minting.
- `packages/agent-scheduler`: release-time injection of the private Scheduler
  Channel.
- `packages/sdk`: the published `eveland` npm package. It must never import a
  workspace package -- Agents install it from the registry, not from here.
- `infra`: Compose, Traefik, systemd, Lima, and real integration-smoke assets.

Keep the dependency direction:

```text
apps -> packages
session-collector -> core + db
agent-auth, identity-broker -> core + db
agent-observer, agent-scheduler -> core
platform-observability, sandbox-bwrap, architecture-tests -> no Eveland package
sdk -> no Eveland package at all
db -> core
core -> no other Eveland package
apps -X-> apps
```

This direction is enforced, not aspirational: the matrix in
`packages/architecture-tests/src/import-boundaries.test.ts` is total over
`packages/`, so a new package must declare its allowed edges there before it
can depend on anything.

Do not add a `packages/core` root barrel. Import its explicit exports such as
`@eveland/core/contracts`, `@eveland/core/eve`, and
`@eveland/core/server/archive`. Shared app behavior belongs in a package, not in
an app-to-app import.

### Architecture ratchets

`packages/architecture-tests` runs in the normal test suite and holds the
structural rules as executable ratchets: the dependency matrix above, the
no-app-to-app and no-deep-import rules, the import-cycle check (allowlist
currently empty), the full-Store consumer allowlist (new code takes a narrow
domain port; the list only shrinks), the browser-safe scan of core's
non-server exports, the source->registry environment coverage, and the
repo-wide consistency suites for the eve compatibility window and the
environment-variable reference.

Editing a ratchet allowlist is a reviewed design decision, not a fix for a
failing build: an addition needs a comment in the allowlist explaining why and
what will remove it again. Deleting or weakening a scan to get a change green
is never acceptable; if a rule is genuinely wrong, change the rule and this
file in the same PR.

Keep composition entrypoints thin. Add behavior to the module that owns the
domain instead of rebuilding monoliths in `packages/db/src/store.ts`,
`packages/db/src/postgres-store.ts`, `apps/api/src/app.ts`,
`apps/gateway/src/app.ts`, or `apps/worker/src/jobs/process.ts`. When tests need
substantial shared setup, put it in a colocated `*.test-support.ts` module
instead of copying fixtures between test files.

## Product and runtime invariants

Preserve these unless the product contract is deliberately changed and the
corresponding tests and docs are updated.

### Control-plane authentication

- The control plane is invite-only. Better Auth owns users, credential
  accounts, and sessions; its Organization plugin backs the single Team's
  members, roles, and invitations behind Eveland-owned endpoints.
- Except for explicitly public health and invitation-acceptance paths,
  control-plane APIs require a valid Team member session. Do not weaken this
  boundary when adding routes.
- Preserve the `admin`/`member` role boundary, last-admin protection,
  single-use seven-day invitation behavior, and immediate session revocation
  when a member is removed.
- Keep `BETTER_AUTH_SECRET`, `APP_SECRET_KEY`, and Gateway secrets independent.
  `BETTER_AUTH_URL` is the browser-visible API origin; only set
  `EVELAND_COOKIE_DOMAIN` when Web and API intentionally share a parent domain.
- Public Agent traffic remains on Gateway's separate Agent-owned
  authentication boundary. A control-plane login must not become an Agent
  credential or a reason to relax Gateway forwarding rules.

### Gateway and routing

- Gateway is not the Agent's identity provider. Preserve Agent-owned
  `Authorization`, cookies, origin semantics, and NDJSON response streaming.
  Request bodies are buffered up to the configured body limit before
  forwarding (routing must inspect initial/reset bodies); upstream response
  bodies stream through, and any response tee (session metadata) must stay
  byte-capped.
- Validate the complete canonical public Host. Strip untrusted
  `Forwarded`/`X-Forwarded-*` and reserved `X-Eveland-*` input, then rebuild only
  trusted platform headers.
- Never rewrite a public Agent request to a localhost Host; that can turn it
  into Eve local-development identity. The privileged `/internal/*` path must
  remain service-authenticated and unreachable through the public proxy.
- Raw Agent ports are private loopback upstreams, not product URLs. Stable,
  preview, and alias URLs resolve through Gateway.
- Route policies have at most two targets and use basis-point weights totaling
  10,000. A root Eve session is pinned to a Deployment; continuation and stream
  requests must keep using that binding after promote, rollback, or weight
  changes.

### Releases, deployments, and runtimes

- A Release is immutable. A Deployment is an independently runnable target
  with an immutable preview address. Stable and alias routes are mutable.
- Build/deploy creates a concurrent preview and must not stop or reuse the
  production target as part of a successful deploy.
- Persist and honor each Deployment's `runtimeKind`. Stop/restart/delete must
  use the adapter that owns that Deployment, not merely the worker's current
  default.
- Docker remains the local-development runtime. The current Linux production
  topology uses Docker Compose for API/Gateway/Web/Postgres and a host systemd
  worker with a shared absolute data root. Do not globally flip runtime or path
  defaults without updating preflight, Compose, env examples, and deployment
  docs.
- API and worker must agree on absolute source, release, and telemetry policy paths. Treat
  build lifecycle scripts and imported project code as untrusted across the
  documented sandbox boundary.

### Observability and usage

- Session collection is OTLP push-first: injected Eve hooks use private
  providers, the managed OpenTelemetry Collector owns retry/persistent queues,
  and Built-in projects standard OTLP into Postgres. Playground streaming is
  not the authoritative collection path.
- User instrumentation is untouched. Never replace or register user global
  tracer, logger, or meter providers; Eveland capture settings control only
  Eveland's injected private providers.
- Observability failure must not make an Agent turn or Worker control-loop
  operation fail. Catch and rate-limit telemetry failures, keep Built-in
  always enabled, and isolate every external exporter's retry queue.
- Delivery is at least once. OTLP batch storage, event projection, usage
  aggregation, and replay must be idempotent and safe under
  child-before-parent and discovery races.
- A platform Session is the root conversation; each root or subagent Eve
  session is a SessionNode. Durable Eve session identity is project-scoped,
  while individual observations retain Deployment provenance.
- Usage comes from Eve's provider-reported `step.completed.data.usage`. Keep
  missing usage explicit rather than estimating it. Do not follow arbitrary
  remote subagent URLs; retain them as unresolved relationships.

### Secrets and privilege boundaries

- Never put secrets in source snapshots, releases, logs, telemetry signals,
  events, fixtures, or client responses. Do not log raw API keys or affinity
  material.
- Gateway must not receive the Docker socket, source tree, telemetry policy data, or
  decrypted project secrets.
- API/collector must not receive host runtime-controller privileges. Worker is
  the only Docker/systemd controller and is not a public service.
- Preserve path-containment, symlink, archive-extraction, process-group cleanup,
  and sandbox self-check protections when changing import/build/runtime code.

## Development modes

Install dependencies with:

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

Set a unique `BETTER_AUTH_SECRET` of at least 32 characters and an
`EVELAND_ADMIN_PASSWORD` of at least 12 characters before starting the API.

Choose exactly one development mode. Do not alternate a native macOS install
and full Compose in the same working tree: Compose installs Linux dependencies
into the mounted workspace and can clobber native `node_modules`.

Native apps with only Postgres in Compose:

```bash
docker compose up -d postgres
pnpm --filter @eveland/api db:migrate
pnpm dev
```

Use the individual `pnpm dev:api`, `dev:gateway`, `dev:web`, and `dev:worker`
scripts in separate terminals when isolated logs are more useful. `pnpm dev`
also starts the optional public docs site; use `pnpm dev:docs` alone when only
that site is needed.

Or run the complete development stack:

```bash
docker compose up
```

Web, API, Gateway, worker, and Postgres participate in the normal end-to-end
path. A pending import/deploy usually means the worker is absent or failing;
Playground/public Agent failures can involve Gateway even when API and web are
healthy. When a Compose worker controls the host Docker daemon,
`EVELAND_HOST_DATA_DIR` must be the host-absolute view of `.eveland-data`.

## Change-specific rules

- Database changes: update `packages/db/src/schema.ts`, repositories/mappers,
  the relevant contract in `store-domains.ts`, and the matching
  `postgres-*-store.ts` domain implementation. Exercise it through the PGlite
  Store tests and real Postgres where multi-connection or driver behavior matters. Keep
  composer files free of domain behavior. Generate a new Drizzle migration
  with `pnpm --filter @eveland/db db:generate`; do not rewrite an
  already-shipped migration. Apply migrations with
  `pnpm --filter @eveland/api db:migrate`; `db:push` is only for disposable
  local databases.
- Contract or ID changes: put shared shapes and rules in the appropriate
  `packages/core` subpath and update every producer and consumer. Preserve the
  repository's prefixed ID alphabet and DNS-safe routing keys.
- API changes: register route families in the appropriate `app-*-routes.ts`
  module, keep validation in `app-schemas.ts`, and keep reusable protocol or
  request helpers in `app-support.ts`.
- Worker changes: keep claiming, heartbeat, completion, and failure fencing in
  `jobs/process.ts`; put concrete import/build or runtime job behavior in the
  corresponding `process-*` module. Test state transitions, retries, and
  idempotency through PGlite, plus real Postgres assumptions where relevant.
- Gateway changes: test Host parsing, header sanitization, auth/cookie
  transparency, body limits, abort propagation, streaming, affinity, and
  internal/public route separation. Pure Host/header/affinity/target rules
  belong in `gateway-routing.ts`; socket and response lifecycle orchestration
  stays in `app.ts`.
- Observability/Collector changes: test OTLP replay, duplicate usage,
  exporter isolation, provenance merge, child-before-parent arrival, degraded
  health, and real Eve event coverage when the protocol surface changes.
- Runtime/sandbox changes: cover runtime selection and startup preflight, then
  use the real Lima/systemd/bwrap smoke path when behavior depends on Linux.
- Web changes: preserve App Router conventions and existing shadcn/Tailwind
  patterns in `apps/web`. Keep the authenticated control panel distinct from
  the bilingual Fumadocs site in `apps/docs`. Test data transforms, auth, and
  navigation contracts; run the relevant production Next build for meaningful
  UI/configuration changes.
- Base UI composition in `apps/web` must preserve semantic HTML and produce one
  interactive element per control. Never render a `Link` through `Button`;
  apply `buttonVariants` directly to the `Link` instead. When a Tooltip, menu,
  dialog, or similar primitive uses an existing button as its trigger, merge it
  with Base UI's `render` prop instead of nesting the button as trigger content.
  Treat `apps/web/src/components/ui` as upstream shadcn source and do not modify
  it for these fixes; correct call sites or higher-level wrappers instead.
- Behavior, topology, environment, public URL, or operational-limit changes
  must update the relevant `docs/spec.md`, `README.md`, `docs/deploy/linux.md`,
  Compose/env examples, and current handoff notes in the same change.

## Verification

Start focused, then run the broadest checks justified by the change.

```bash
# Example focused test
pnpm --filter @eveland/worker exec vitest run src/runtime/select.test.ts

# Repository baseline for code changes
pnpm test
pnpm typecheck
pnpm build

# Before handoff
git diff --check
git status --short
```

Additional expectations:

- Run `pnpm --filter @eveland/web build` for web, Next configuration, or
  browser/server-boundary changes.
- Run `pnpm --filter @eveland/docs build` for public-site, Fumadocs, MDX,
  search, sitemap, or localization changes.
- Validate the merged Compose configuration after Compose/env changes.
- Run `bash -n infra/integration/run.sh` after editing the integration harness.
- Run `bash infra/integration/run.sh` for systemd, bwrap, build isolation,
  observability, private-port, or Gateway behavior that requires the real Linux
  topology. It is intentionally heavier than unit tests and requires Lima.
- For multi-connection locking, driver behavior, and migration compatibility,
  exercise the relevant real Postgres integration path; single-connection
  PGlite alone is not proof of those semantics.

Report exactly what was run, what passed, and what was not run. Do not describe
an unexecuted smoke test as verified.
