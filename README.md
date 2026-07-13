# Eveland

Self-hosted control plane for importing, deploying, and observing `eve` projects.

## Current MVP Slice

- `packages/core`: dependency-free Eveland contracts plus explicit Eve protocol, ID, source, schedule, archive, secret, and runtime-command subpaths. It intentionally has no root barrel so browser-safe imports cannot accidentally pull in Node-only code.
- `packages/db`: Drizzle schema and migrations, Postgres repository, memory repository, mappers, and store factory shared by API and worker.
- `packages/sandbox-bwrap`: bubblewrap-based eve `SandboxBackend` giving agents deployed on the systemd runtime a real exec sandbox without Docker/KVM. The worker injects it into each eve project's release at build time — the deployed project never declares it (see `packages/sandbox-bwrap/README.md`).
- `packages/agent-observer`: release-time Eve hook injection for root and directory-form subagents. Hooks write durable envelopes without importing Eveland runtime code.
- `packages/session-collector`: filesystem outbox claim/lease recovery, validation, ingestion, and Session/usage projection.
- `apps/api`: Hono API with the public project/secrets/schedules/sessions/logs contract, an embedded observer collector, and BetterAuth dependency. Persistence is supplied by `packages/db`.
- `apps/gateway`: Host-routed public Agent data plane. It preserves Agent auth/cookies and streaming bodies, pins Eve sessions to deployments, and keeps raw Agent ports private.
- `apps/worker`: Docker runtime adapter, Postgres job consumer, and worker processors for import/build/restart/schedule job state transitions.
- `apps/web`: Next.js App Router control panel using the requested shadcn preset and Tailwind v4.

## Local Development

```bash
pnpm install
docker compose up -d postgres          # start the database
pnpm --filter @eveland/api db:migrate  # apply versioned migrations (required on first run and after schema changes)
pnpm --filter @eveland/api dev
pnpm --filter @eveland/gateway dev
pnpm --filter @eveland/web dev
pnpm --filter @eveland/worker dev
```

Open `http://localhost:3000`.

All four processes are required: the web form posts to the API, Playground/public Agent traffic goes through Gateway, and imports, builds, and deploys are executed by the worker's job polling — without it, projects stay pending after upload.

Docker Compose runs the full stack (Postgres + API + Gateway + web + worker) in **development mode**:

```bash
docker compose up
```

The service images are `node:24-alpine` with `git` / `docker-cli` / `unzip` installed at
startup — the app shells out to them for git import, agent deploy, and zip-upload extraction.
When the worker runs in Compose, `EVELAND_HOST_DATA_DIR` must be the host-absolute path
to the workspace's `.eveland-data`; this lets deployment containers bind the same observer
outbox that the API's embedded collector reads.
Public development endpoints use `http://<routingKey>.agent.localhost:4080`; immutable previews use
`http://<deploymentKey>--<routingKey>.agent.localhost:4080`. Gateway validates the complete Host,
while deployment ports remain bound only to `127.0.0.1` and are not product URLs.

Pick one mode: either everything in Compose, or only `postgres` in Compose and the rest natively. The Compose services run `pnpm install` inside Linux containers against the mounted workspace, which clobbers a macOS-built `node_modules`.

## Production (single-box deploy)

Deploy the whole stack in Docker on one Linux host by layering the production overlay. Set the
two public URLs for the target environment in `.env`, then bring it up:

```bash
# .env
WEB_ORIGIN=https://your-web-host
NEXT_PUBLIC_API_URL=https://your-api-host
EVELAND_AGENT_BASE_DOMAINS=agents.example.com
EVELAND_GATEWAY_SERVICE_TOKEN=<long-random-service-secret>
EVELAND_GATEWAY_AFFINITY_SECRET=<independent-long-random-cookie-secret>

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

`docker-compose.prod.yml` runs a production build (`next build && next start`,
`NODE_ENV=production`), uses **host networking** so the worker (health check) and Gateway
can reach agents published on the host loopback, and sets
`restart: unless-stopped` so the stack returns after a host reboot. The worker deploys
agents through the mounted Docker socket, so the target is a Linux host running Docker.

## Verification

```bash
pnpm test
pnpm typecheck
```

## Notes

- API uses Postgres when `DATABASE_URL` is set; tests use the memory store.
- `packages/db/src/schema.ts` and `packages/db/drizzle/` are the Postgres model and migration targets. Use `pnpm --filter @eveland/api db:migrate` for real databases; `db:push` is only a disposable-development convenience.
- Token accounting uses Eve's `step.completed.data.usage` values. Injected hooks write envelopes to `$EVELAND_DATA_DIR/observer`; the API's embedded collector validates and projects them exactly once. Input, output, cache-read, cache-write, and optional gateway cost are attributed to the Eve session node that consumed them. Missing provider usage stays explicitly marked instead of being estimated.
- The Playground transport only returns the current reply and timeline. It does not collect or project usage. Observer envelopes discover direct private-port, Playground, schedule, and child sessions independently, then merge more-specific provenance by `(projectId, eveSessionId)`.
- Playground calls use Gateway's service-authenticated `/internal/projects/:projectId/playground` path. Traefik must expose only wildcard Agent hosts and exclude `/internal`; `infra/traefik/agents.yml` is the single-box example.
- Build/deploy creates a concurrent immutable preview and never stops or reuses the current production process. Promote, rollback, and one/two-target traffic policies are atomic route updates followed by Gateway cache invalidation; existing Eve sessions remain pinned by `SessionBinding` even after their target leaves production traffic.
- Route weights use 10,000 basis points, must total 10,000, and support at most two targets. Each multi-target policy revision becomes an experiment ID persisted with the deployment and variant binding, so the deployment page compares success/failure, latency, tokens, and cost without mixing revisions. Named aliases share the wildcard domain. Retention keeps at least the newest three release artifacts and refuses to archive mutable route targets or deployments with active session bindings.
- Eve 0.22.1 gives directory-form subagents an independent hook slot, so they are fully observed. File-form subagents have no hook slot and their parent stream exposes only control events; they are a documented coverage gap until Eve exposes a public observation surface. Remote calls retain the reported URL as an unresolved relationship and are never followed by the collector.
- Markdown eve schedules are executable in the MVP plan; TypeScript schedules are discovery-only until the native eve schedule runtime is integrated.
- Deployed agents get `WORKFLOW_POSTGRES_URL` injected so an `@workflow/world-postgres` agent has a durable workflow store. Set it on the worker (compose sets it for you; for native dev export `WORKFLOW_POSTGRES_URL=postgres://eveland:eveland@host.docker.internal:5432/eveland`). It must use a container-reachable host — not `localhost` — because agent containers reach the host DB via `host.docker.internal`. A project secret of the same name overrides it.
- `NODE_ENV` gates deploys: with `NODE_ENV=production` on the worker, deploying an agent without a durable workflow world fails; unset (development) only warns. A production eveland sets `NODE_ENV=production` on the worker, which is also injected into deployed agent containers.
