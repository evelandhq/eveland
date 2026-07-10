# Eveland

Self-hosted control plane for importing, deploying, and observing `eve` projects.

## Current MVP Slice

- `packages/shared`: tested core behavior for IDs, archive path safety, eve source inspection, schedule parsing, next-run calculation, secret encryption, and runtime command inference.
- `packages/sandbox-bwrap`: bubblewrap-based eve `SandboxBackend` giving agents deployed on the systemd runtime a real exec sandbox without Docker/KVM. The worker injects it into each eve project's release at build time — the deployed project never declares it (see `packages/sandbox-bwrap/README.md`).
- `apps/api`: Hono API with the public project/secrets/schedules/sessions/logs contract, provider-reported per-agent token usage collected from Eve session streams, BetterAuth dependency, Drizzle/Postgres schema, and Postgres-backed store when `DATABASE_URL` is set.
- `apps/worker`: Docker runtime adapter, Postgres job consumer, and worker processors for import/build/restart/schedule job state transitions.
- `apps/web`: Next.js App Router control panel using the requested shadcn preset and Tailwind v4.

## Local Development

```bash
pnpm install
docker compose up -d postgres          # start the database
pnpm --filter @eveland/api db:push     # create/update tables (required on first run and after schema changes)
pnpm --filter @eveland/api dev
pnpm --filter @eveland/web dev
pnpm --filter @eveland/worker dev
```

Open `http://localhost:3000`.

All three processes are required: the web form posts to the API, and imports, builds, and deploys are executed by the worker's job polling — without it, projects stay pending after upload.

Docker Compose runs the full stack (Postgres + API + web + worker) in **development mode**:

```bash
docker compose up
```

The service images are `node:24-alpine` with `git` / `docker-cli` / `unzip` installed at
startup — the app shells out to them for git import, agent deploy, and zip-upload extraction.

Pick one mode: either everything in Compose, or only `postgres` in Compose and the rest natively. The Compose services run `pnpm install` inside Linux containers against the mounted workspace, which clobbers a macOS-built `node_modules`.

## Production (single-box deploy)

Deploy the whole stack in Docker on one Linux host by layering the production overlay. Set the
two public URLs for the target environment in `.env`, then bring it up:

```bash
# .env
WEB_ORIGIN=https://your-web-host
NEXT_PUBLIC_API_URL=https://your-api-host
EVELAND_PUBLIC_ORIGIN=https://your-api-host

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

`docker-compose.prod.yml` runs a production build (`next build && next start`,
`NODE_ENV=production`), uses **host networking** so the worker (health check) and API
(playground proxy) can reach agent containers published on the host loopback, and sets
`restart: unless-stopped` so the stack returns after a host reboot. The worker deploys
agents through the mounted Docker socket, so the target is a Linux host running Docker.

## Public agent endpoints

Every deployed agent is reachable through the API's agent gateway at
`<api origin>/a/<shortId>/...`, where `<shortId>` is the project id without its `proj_`
prefix. The gateway stream-proxies to the agent's deployment and exposes only the eve
contract surface — the `/eve/v1` session API and channel webhooks, plus durable-workflow
webhooks under `/.well-known/workflow/` — so eve clients can point their `host` at
`<api origin>/a/<shortId>` directly:

```
POST https://your-api-host/a/<shortId>/eve/v1/session
GET  https://your-api-host/a/<shortId>/eve/v1/session/<sessionId>/stream
```

The running agents are discoverable at `GET <api origin>/.well-known/eve/agents.json`,
which returns `{ "agents": [{ "id": "<shortId>", "name": "...", "url": "<api origin>/a/<shortId>" }] }`
(CORS `*`), so clients can list connectable agents without the management API.

Authentication is the agent's own concern (the eve channel `auth` option); the platform
does not add one. `EVELAND_PUBLIC_ORIGIN` is handed to every deployed agent as
`WORKFLOW_LOCAL_BASE_URL=${EVELAND_PUBLIC_ORIGIN}/a/<shortId>` so the durable-workflow
webhook URLs it mints are externally reachable; unset, it falls back to
`http://localhost:$PORT` for local development. Known limitation: eve resolves
remote-agent *callback* URLs against the origin only, dropping the `/a/<shortId>` path
prefix, so projects that dispatch to remote agents are not yet supported through the
gateway.

## Verification

```bash
pnpm test
pnpm typecheck
```

## Notes

- API uses Postgres when `DATABASE_URL` is set; tests use the memory store.
- `apps/api/src/db/schema.ts` and `apps/api/drizzle/` are the Postgres model and migration targets.
- Token accounting uses Eve's `step.completed.data.usage` values. Input, output, cache-read, cache-write, and optional gateway cost are recorded per model step and attributed to the Eve session and agent that consumed them. Missing provider usage stays explicitly marked as missing rather than being estimated or treated as reported zero usage.
- The Playground collector follows local `subagent.called` child-session streams recursively. Remote child URLs are not fetched directly; they are recorded as `usage.collection_failed` until they can be resolved through a managed deployment mapping. Child telemetry failures do not fail the root agent turn.
- Markdown eve schedules are executable in the MVP plan; TypeScript schedules are discovery-only until the native eve schedule runtime is integrated.
- Deployed agents get `WORKFLOW_POSTGRES_URL` injected so an `@workflow/world-postgres` agent has a durable workflow store. Set it on the worker (compose sets it for you; for native dev export `WORKFLOW_POSTGRES_URL=postgres://eveland:eveland@host.docker.internal:5432/eveland`). It must use a container-reachable host — not `localhost` — because agent containers reach the host DB via `host.docker.internal`. A project secret of the same name overrides it.
- `NODE_ENV` gates deploys: with `NODE_ENV=production` on the worker, deploying an agent without a durable workflow world fails; unset (development) only warns. A production eveland sets `NODE_ENV=production` on the worker, which is also injected into deployed agent containers.
