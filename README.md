# Eveland

[![CI](https://github.com/evelandhq/eveland/actions/workflows/ci.yml/badge.svg)](https://github.com/evelandhq/eveland/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/evelandhq/eveland)](https://github.com/evelandhq/eveland/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![npm (SDK)](https://img.shields.io/npm/v/eveland?label=eveland%20SDK)](https://www.npmjs.com/package/eveland)

Self-hosted platform for importing, deploying, and observing [eve](https://eve.dev)
projects: import an Eve project from a Git repo or Zip upload, configure its runtime
environment, deploy it behind a public Agent Gateway, and observe its Sessions, usage,
schedules, and logs.

> **Status: pre-1.0.** Eveland is used in production by its maintainers, but the
> 0.x line makes breaking changes in minor releases (each is documented in the
> [CHANGELOG](CHANGELOG.md) and in
> [`docs/en/operations/upgrades.md`](docs/en/operations/upgrades.md)). Production
> deployments run on Linux with the systemd runtime (bubblewrap sandboxing);
> the Docker runtime is for development, not production. Development works on
> macOS and Linux with Node ≥ 24 and pnpm 11.

Eveland is a pnpm monorepo. The authenticated Dashboard, platform API, Agent
Gateway, worker, and workflow dispatcher ship together as one SemVer-versioned
product; the bilingual documentation site is built from the same repository.

Production installation and operations are documented at
[eveland.ai/docs](https://eveland.ai/docs), whose content is single-sourced from the
[`docs/`](docs/) tree in this repository. Product boundaries and architecture principles are specified in
[`spec.md`](spec.md); the per-domain behavioral contracts live in the bilingual
[`docs/*/reference`](docs/en/reference/) pages. This README covers
local development and contribution.

## Quickstart (local development)

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env                  # set BETTER_AUTH_SECRET and EVELAND_ADMIN_PASSWORD
docker compose up -d postgres otel-collector # database and platform OTLP receiver
pnpm --filter @evelandhq/api db:migrate  # required on first run and after schema changes
pnpm dev                               # start all six dev processes
```

Open the Dashboard at `http://localhost:3000` and the public documentation site at
`http://localhost:3001`.

- The initial Admin email defaults to `admin@example.com`; its password comes only from
  `EVELAND_ADMIN_PASSWORD` and must contain at least 12 characters.
  `BETTER_AUTH_SECRET` is a separate random secret of at least 32 characters, and
  `BETTER_AUTH_URL` must be the browser-visible API origin.
- `pnpm dev` starts six processes — API, Agent Gateway, Dashboard, worker, workflow
  dispatcher, and docs — and all but docs are required: the Dashboard posts to the
  API, Playground/public Agent traffic goes through Agent Gateway, imports, builds,
  and deploys are executed by the worker's job polling, and durable workflow wake
  and continuation need exactly one workflow dispatcher.
- Use `pnpm dev:api`, `pnpm dev:gateway`, `pnpm dev:web`, `pnpm dev:worker`,
  `pnpm dev:workflow-dispatcher`, and `pnpm dev:docs` in separate terminals when
  isolated logs are more useful. `dev:worker` does not start the dispatcher.
- Public development endpoints use `http://<projectSlug>.agent.localhost:4080`;
  immutable previews use
  `http://<eightCharacterDeploymentKey>--<projectSlug>.agent.localhost:4080`.
  Deployment ports stay bound to `127.0.0.1` and are not product URLs.

## Documentation map

| Looking for                                   | Go to                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Why Eveland exists                            | [`docs/en/why.md`](docs/en/why.md) — also at [eveland.ai/docs/why](https://eveland.ai/docs/why) |
| Production install, operations, and reference | [eveland.ai/docs](https://eveland.ai/docs) — sourced from [`docs/`](docs/)                      |
| Product contract (principles + reference)     | [`spec.md`](spec.md) + [`docs/*/reference`](docs/en/reference/) (bilingual)                     |
| Working conventions for coding agents         | [`AGENTS.md`](AGENTS.md)                                                                        |
| How to contribute                             | [`CONTRIBUTING.md`](CONTRIBUTING.md)                                                            |
| Reporting security issues                     | [`SECURITY.md`](SECURITY.md)                                                                    |
| Design decisions (the "why")                  | [`docs/en/reference/design/`](docs/en/reference/design/)                                        |

The `docs/en` and `docs/zh` trees are the published site content and must stay in
sync — edit both languages together.

## Production installation

The production topology (Docker Compose core services, host systemd worker and
workflow dispatcher, Traefik wildcard routing) is documented at
[eveland.ai/docs/production](https://eveland.ai/docs/production), sourced from
[`docs/en/production/`](docs/en/production/) — the in-repo Markdown is readable
standalone if the site is unavailable.

## Getting help

- **Bugs and feature requests** — [GitHub issues](https://github.com/evelandhq/eveland/issues)
- **Security vulnerabilities** — [`SECURITY.md`](SECURITY.md); never a public issue
- **Contributing** — [`CONTRIBUTING.md`](CONTRIBUTING.md) and the
  [Code of Conduct](CODE_OF_CONDUCT.md)

## Contributing

### Repository layout

| Path                              | What it is                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                        | Hono platform API with Better Auth sessions, team membership, and the authenticated Built-in OTLP ingest endpoint                     |
| `apps/gateway`                    | The Agent Gateway — host-routed public Agent data plane; preserves Agent auth/cookies and streaming, pins Eve sessions to deployments |
| `apps/web`                        | The Dashboard — Next.js App Router console (shadcn preset, Tailwind v4)                                                               |
| `apps/worker`                     | Docker and systemd runtime adapters plus the Postgres job consumer for import, build, restart, and schedule jobs                      |
| `apps/workflow-dispatcher`        | External dispatcher for durable workflow timers and wake, running exactly once per installation                                       |
| `apps/docs`                       | Bilingual public website and documentation for `eveland.ai` (Next.js + Fumadocs), rendering the repo-root `docs/` tree                |
| `packages/core`                   | Dependency-free contracts plus explicit Eve protocol, ID, source, schedule, archive, secret, and runtime-command subpaths             |
| `packages/db`                     | Drizzle schema and migrations, and the one domain-oriented SQL Store shared by production Postgres and PGlite tests                   |
| `packages/agent-observer`         | Release-time Eve hook injection with private OpenTelemetry providers that never mutate a user's global providers                      |
| `packages/agent-auth`             | Playground authentication registry, OIDC acquisition (Authorization Code + PKCE), and credential materialization                      |
| `packages/identity-broker`        | Agent-user identity finalization, Identity Sessions, project-audience Caller Tokens, signing-key rotation, and public JWKS            |
| `packages/agent-scheduler`        | Release-time injection of the private Scheduler Channel, including Extension-contributed schedules                                    |
| `packages/platform-observability` | Shared OpenTelemetry SDK bootstrap for Eveland services                                                                               |
| `packages/session-collector`      | Standard OTLP decoding and projection into the built-in Session, usage, and instance-health read models                               |
| `packages/sdk`                    | The published `eveland` npm package (`eveland/auth`, `evelandIdentity()`); see its [README](packages/sdk/README.md)                   |
| `packages/architecture-tests`     | Executable ratchets for dependency direction, import cycles, browser-safe core exports, and environment-variable coverage             |
| `infra`                           | Compose, Traefik, systemd, Lima, and real integration-smoke assets                                                                    |

### Development modes

Pick one mode per working tree: either the native quickstart above with only
`postgres`/`otel-collector` in Compose, or everything in Compose:

```bash
docker compose up
```

Compose runs the complete stack (Postgres, OpenTelemetry Collector, API, Agent
Gateway, Dashboard, worker, workflow dispatcher) in **development mode**. Only the
worker receives the Docker controller socket; Agent Gateway and the dispatcher mask
`.eveland-data` so they cannot read imported sources or encrypted project secrets.
When the worker runs in Compose, `EVELAND_HOST_DATA_DIR` must be the host-absolute
path to the workspace's `.eveland-data`. Do not alternate modes: the Compose
services run `pnpm install` inside Linux containers against the mounted workspace,
which clobbers a macOS-built `node_modules`.

### Verification

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

### Release process

Releases are automated by [Release Please](https://github.com/googleapis/release-please):

1. Feature PRs merge to `main` with Conventional Commit titles (`fix:`, `feat:`,
   `feat!:`). Non-conventional messages are silently skipped — they never appear
   in the changelog and do not influence the version.
2. `.github/workflows/release.yml` maintains a single Release PR with the next
   version and `CHANGELOG.md` entries.
3. A maintainer merges that Release PR only after CI and the checklist below are
   green. Release Please then creates the `vX.Y.Z` tag and GitHub Release. Only
   `vX.Y.Z` tags are stable releases; `main` is the `edge` channel.

`RELEASE_PLEASE_TOKEN` should be a repository-scoped or GitHub App token that can
write contents and pull requests. The workflow falls back to `GITHUB_TOKEN`, but
GitHub does not trigger follow-on workflows for resources created by that token,
so CI on an automatically opened Release PR may require the dedicated token.

Before merging a Release PR:

- `pnpm test`, `pnpm typecheck`, and `pnpm build` pass;
- migration changes include an additive/staged upgrade path and real Postgres
  verification;
- `spec.md`, `README.md`, the `docs/` tree, examples, and environment templates
  match the shipped behavior;
- the Release PR describes operator actions, compatibility changes, known limits,
  and rollback constraints;
- the version constant and root manifest still match;
- the target commit is clean and `git diff --check` passes.

The bubblewrap sandbox backend
[`@evelandhq/sandbox-bwrap`](https://github.com/evelandhq/sandbox-bwrap) is not
versioned with the Eveland product: it lives in its own repository, releases on
its own line, and is consumed here as a published npm dependency of the worker.
Upgrading it is an ordinary dependency bump; nothing in this repository builds it.

The operator-facing versioning policy and upgrade/rollback procedure live in
[`docs/en/operations/upgrades.md`](docs/en/operations/upgrades.md).

### Public docs deployment

`apps/docs` is deployed as the `eveland-docs` Cloudflare Worker at
`https://eveland.ai` through the OpenNext adapter. Build or preview the Worker
runtime locally with `pnpm --filter @evelandhq/docs build:cloudflare` and
`preview:cloudflare`. The `Deploy docs` GitHub Actions workflow deploys after a
push to `main` when the pushed changes include `apps/docs/**` or `docs/**`; it
requires the `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` repository
secrets. `apps/docs/wrangler.jsonc` owns the Worker name and custom-domain
binding.

### License

Copyright (C) 2026 Jinzhou Chen.

Eveland is licensed under the [GNU Affero General Public License v3.0](LICENSE);
third-party attributions are listed in [`NOTICE`](NOTICE). Two deliberate
exceptions are more permissive: the published
[`eveland` SDK](packages/sdk/) that Agents import is Apache-2.0 (so using it in
your own Agent carries no copyleft obligation), and the bubblewrap sandbox
backend [`@evelandhq/sandbox-bwrap`](https://github.com/evelandhq/sandbox-bwrap)
is a separate Apache-2.0 project.
