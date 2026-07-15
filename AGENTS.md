# AGENTS.md

This file applies to the entire repository. It is working guidance for coding
agents; product behavior still belongs in the product and deployment docs.

## Start here

Before changing code:

1. Read `docs/spec.md` for the product contract.
2. Read `README.md` for the current repository shape and local workflow.
3. For Linux, systemd, sandbox, or host-worker work, also read
   `docs/deploy/linux.md`.
4. For Gateway, observability, routing, or versioned Deployment work, read the
   relevant decisions in
   `docs/superpowers/plans/2026-07-13-gateway-observability-handoff.md`.
   Treat completed phase checklists in planning documents as history, not as a
   current backlog.
5. Inspect the implementation, nearby tests, and `git status` before proposing
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
- `apps/api`: Hono control-plane API, Better Auth/team host, and the current
  embedded collector host.
- `apps/gateway`: public Agent data plane and internal privileged Playground
  path.
- `apps/worker`: import, build, deployment, restart, scheduling, health, and
  runtime-controller jobs.
- `packages/core`: shared contracts and domain logic, split into explicit
  browser-safe and Node-only subpath exports.
- `packages/db`: Drizzle schema, migrations, repositories, mappers, memory
  store, and Postgres store.
- `packages/agent-observer`: release-time Eve hook injection.
- `packages/session-collector`: observer outbox claiming, validation,
  ingestion, and projection.
- `packages/sandbox-bwrap`: the systemd runtime's Eve exec sandbox backend.
- `infra`: Compose, Traefik, systemd, Lima, and real integration-smoke assets.

Keep the dependency direction:

```text
apps -> packages
session-collector -> core + db
db -> core
core -> no other Eveland package
apps -X-> apps
```

Do not add a `packages/core` root barrel. Import its explicit exports such as
`@eveland/core/contracts`, `@eveland/core/eve`, and
`@eveland/core/server/archive`. Shared app behavior belongs in a package, not in
an app-to-app import.

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
  `Authorization`, cookies, origin semantics, request streaming, and NDJSON
  response streaming.
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
- API and worker must agree on absolute source/release/outbox paths. Treat
  build lifecycle scripts and imported project code as untrusted across the
  documented sandbox boundary.

### Observability and usage

- Session collection is push-first: injected Eve hooks write a durable
  filesystem outbox and the collector projects it to Postgres. Playground
  streaming is not the authoritative collection path.
- Observer failure must not make an Agent turn fail. Catch and rate-limit
  observer I/O failures, expose degraded collector health, and preserve queued
  envelopes for recovery.
- Delivery is at least once. Claims, event projection, usage aggregation, and
  replay must be idempotent and safe under child-before-parent and discovery
  races.
- A platform Session is the root conversation; each root or subagent Eve
  session is a SessionNode. Durable Eve session identity is project-scoped,
  while individual observations retain Deployment provenance.
- Usage comes from Eve's provider-reported `step.completed.data.usage`. Keep
  missing usage explicit rather than estimating it. Do not follow arbitrary
  remote subagent URLs; retain them as unresolved relationships.

### Secrets and privilege boundaries

- Never put secrets in source snapshots, releases, logs, observer filenames,
  events, fixtures, or client responses. Do not log raw API keys or affinity
  material.
- Gateway must not receive the Docker socket, source tree, observer data, or
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
  both memory and Postgres behavior, and generate a new Drizzle migration with
  `pnpm --filter @eveland/db db:generate`. Do not rewrite an already-shipped
  migration. Apply migrations with `pnpm --filter @eveland/api db:migrate`;
  `db:push` is only for disposable local databases.
- Contract or ID changes: put shared shapes and rules in the appropriate
  `packages/core` subpath and update every producer and consumer. Preserve the
  repository's prefixed ID alphabet and DNS-safe routing keys.
- API/worker changes: test state transitions, retries, idempotency, and both
  memory-store and Postgres assumptions where relevant.
- Gateway changes: test Host parsing, header sanitization, auth/cookie
  transparency, body limits, abort propagation, streaming, affinity, and
  internal/public route separation.
- Observer/collector changes: test replay, duplicate usage, claim recovery,
  provenance merge, child-before-parent arrival, degraded health, and real Eve
  event coverage when the protocol surface changes.
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
  observer, private-port, or Gateway behavior that requires the real Linux
  topology. It is intentionally heavier than unit tests and requires Lima.
- For database semantics, exercise the relevant Postgres integration path; the
  in-memory store alone is not proof of SQL constraints or transaction behavior.

Report exactly what was run, what passed, and what was not run. Do not describe
an unexecuted smoke test as verified.
