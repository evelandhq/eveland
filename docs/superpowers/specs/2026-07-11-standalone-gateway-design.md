# Standalone agent gateway: a dedicated domain per agent

Design for [issue #19](https://github.com/evelandhq/eveland/issues/19). Every deployed
agent gets a stable domain `<slug>.<agent apex domain>`; a new standalone gateway
service routes those domains to the agent's process port and hosts a discovery
endpoint for external clients (e.g. eve-chats).

## Resolved decisions

- **Public surface**: the whole domain is forwarded to the agent process. The domain is
  the isolation boundary (dedicated apex, single flattened subdomain level); agents may
  ship their own UI/static assets. The gateway reserves only `/healthz` for itself.
- **Slug**: auto-generated from the project name at creation, editable afterwards via
  `PATCH /projects/:projectId`. Changing the slug invalidates the old domain
  immediately; no redirect.
- **TLS**: terminated by an external ingress (the wildcard certificate is an ops
  dependency, not code). The gateway listens on plain HTTP only. Public URL scheme and
  port are configuration.
- **Dev domain**: `lvh.me` (public DNS resolves `*.lvh.me` to `127.0.0.1`), so browser,
  curl, and Node all work with zero configuration while developing.
- **Discovery**: `/.well-known/eve/agents.json` is public, no auth. Gateway-level
  auth/rate limiting stays a follow-up per the issue.
- **Web UI**: minimal — show the agent URL on the project page and allow editing the
  slug. API is the contract; the UI is a thin veneer.
- **Implementation shape**: a new `apps/gateway` service written in TypeScript on
  `node:http`, proxying by hand (no proxy library). It reads routing state from
  Postgres directly (read-only) with an in-process cache invalidated via
  `LISTEN/NOTIFY`. The control plane (api/worker) remains the only writer.

## Architecture

```
browser / eve-chats / workflow callbacks
        │  https://<slug>.<EVELAND_AGENT_DOMAIN>     (TLS at external ingress)
        ▼
  [external ingress] ──plain http──▶ [gateway :8080] ──▶ http://<hostAddress>:<hostPort>
                                        │  ▲                    (agent process)
                                 route lookup│  │ LISTEN/NOTIFY
                                        ▼  │
                                     [Postgres] ◀──writes── api / worker (control plane)
```

`apps/gateway` (`@eveland/gateway`) is a fourth app alongside api/web/worker: its own
process/container, independently restartable, horizontally scalable (it holds no
state beyond a cache). It imports the drizzle schema from `@eveland/api` for read-only
queries. There is no memory-store mode: startup fails fast (worker-preflight style,
one aggregated error) when `DATABASE_URL` or `EVELAND_AGENT_DOMAIN` is missing.

## Data model

### `projects.slug`

- `text` NOT NULL, unique index `projects_slug_idx`.
- Validation (shared util + zod): `/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/` (DNS
  label, max 63 chars, no leading/trailing hyphen), plus a small reserved list:
  `www`, `api`, `gateway`, `eveland`, `admin`.
- Generation: `slugifyProjectName(name)` in `@eveland/shared` — lowercase, collapse
  runs of non-`[a-z0-9]` to `-`, trim hyphens, truncate to 40 chars; a name that
  slugifies to nothing (e.g. all CJK) falls back to `agent`. On unique-index conflict
  the store retries with a 4-char random suffix. The suffix needs a lowercase+digit
  alphabet — the existing `createId` alphabet contains uppercase and is not DNS-safe.
- Migration: add nullable column → backfill (slugified `name`, suffixed with a slice of
  `id` on collision) → set NOT NULL + unique index. Same tighten-after-backfill shape
  as the `runtimeKind` migration.

### `deployments.hostAddress`

- `text` NOT NULL, migration backfills `'127.0.0.1'`.
- This is issue #19's open decision 2 (cluster readiness): the routing table stores
  node address + port rather than assuming loopback. The worker writes `'127.0.0.1'`
  today (`recordDeployment` gains the field); cross-node forwarding is future work.
  The gateway always dials `hostAddress:hostPort` and never assumes loopback itself.

### Store interface

`createProject` accepts an optional `slug` (default: auto-generate);
`updateProjectSlug(projectId, slug)` is new and throws a distinct conflict error the
API maps to 409; `recordDeployment` gains `hostAddress`. `Project` gains `slug`,
`DeploymentRecord` gains `hostAddress`. Both stores (memory + postgres) implement all
of it — the memory store keeps unit tests DB-free.

## Routing state: query, cache, invalidation

### Lookup (gateway, read-only)

```sql
SELECT p.slug, p.name, d.host_address, d.host_port
FROM projects p JOIN deployments d ON d.id = p.deployment_id
WHERE p.slug = $1 AND d.status = 'running'
```

Routing keys off `projects.deployment_id`: during a build the pointer still references
the previous deployment, whose process keeps serving until the worker stops it right
before starting the new one — the availability gap is the actual process swap, not the
whole build.

The gateway defines a `RouteSource` interface (`lookup(slug)`, `listAgents()`,
`subscribe(onInvalidate)`) with the Postgres implementation behind it; proxy tests
inject a fake and never touch the DB.

### In-process cache

- `Map<slug, { route | null, expiresAt }>` — negative entries (unknown slug → `null`)
  are cached too, so unknown-host floods don't hammer Postgres.
- TTL `EVELAND_GATEWAY_ROUTE_TTL_MS` (default 30s) for positive and negative entries.
- Bounded: past 10,000 entries the whole map is cleared (no LRU dependency; normal
  scale never gets close).
- The cache is a performance optimization only; Postgres is the source of truth. A
  lost invalidation degrades to at most one TTL window of staleness, never permanent
  drift.

### LISTEN/NOTIFY

- DB triggers (created in the migration, not application-level notify calls) publish
  to channel `eveland_routes`:
  - `projects`: UPDATE touching `slug`, `deployment_id`, or `deployment_status` →
    `pg_notify` with the old slug (and the new slug when it changed); DELETE → old slug.
  - `deployments`: UPDATE touching `status`, `host_port`, or `host_address` → notify
    with the owning project's slug (looked up in the trigger).
  - Triggers rather than store-level calls so every future write path — new job types,
    manual SQL repair — invalidates automatically.
- The gateway uses postgres-js `listen('eveland_routes', ...)`. A message evicts that
  slug; an unparseable/empty payload clears the whole cache. On (re)connect of the
  listener the cache is cleared wholesale — NOTIFY is a non-durable hint, and missed
  messages must heal via the reconnect clear + TTL, not accumulate as drift.

## Gateway request handling

Order per request:

1. **`GET /healthz`** — served before host classification (any Host), returns
   `{ ok: true, service: "eveland-gateway" }`. Load balancer probes must not depend on
   routing state. This shadows a deployed agent's own `/healthz`; documented.
2. **Host normalization**: take `Host`, strip port, lowercase, strip trailing dot.
3. **Apex branch** (host equals `EVELAND_AGENT_DOMAIN`): serves only
   `GET /.well-known/eve/agents.json`; everything else 404.
4. **Subdomain branch** (host equals `<label>.EVELAND_AGENT_DOMAIN`, label must be a
   single level — no dots): label is the slug → route lookup → proxy. Multi-level
   subdomains and unrelated hosts get 404 (JSON body). The flattened single-label
   convention keeps one wildcard cert covering every future domain (previews will be
   `<githash>-<slug>`, not nested).

### Proxy behavior

- Method, path, query, and body are forwarded verbatim; request and response bodies
  are piped as streams with **no buffering** (NDJSON long-poll streams are the primary
  workload; response headers are written the moment upstream headers arrive).
- The original `Host` header is preserved (the agent's view of itself is its public
  domain). `x-forwarded-for` is appended; `x-forwarded-proto` / `x-forwarded-host` are
  passed through when already set and synthesized otherwise. The deployment contract
  is that the gateway sits behind a trusted ingress which sets them; when exposed
  directly (dev) a client can spoof them, which is accepted for v1 — the gateway makes
  no auth decisions on these headers.
- Hop-by-hop headers are stripped in both directions: `connection`, `keep-alive`,
  `te`, `trailer`, `transfer-encoding`, `upgrade` (outside the upgrade path),
  `proxy-authenticate`, `proxy-authorization`.
- Upstream **header-phase timeout** `EVELAND_GATEWAY_UPSTREAM_TIMEOUT_MS` (default
  30s): applies until response headers arrive; after that the stream is unbounded.
- **WebSocket**: `server.on("upgrade")` runs the same host/route resolution, dials the
  upstream with `net.connect`, writes the request line + filtered headers, then pipes
  the two sockets raw in both directions. Failure before the handshake completes
  answers with a raw 502 and destroys the socket.

### Error mapping

| Case | Response |
|---|---|
| Host doesn't match the agent domain / multi-level subdomain / unknown slug | 404 JSON |
| Slug exists but no current deployment | 503 JSON |
| Upstream `ECONNREFUSED` (deployment swap window) | 503 JSON |
| Other upstream connect/stream errors | 502 JSON |
| Upstream header-phase timeout | 504 JSON |
| Route lookup failure (DB down, cache miss) | 503 JSON |

## Configuration

| Variable | Consumed by | Default | Meaning |
|---|---|---|---|
| `EVELAND_AGENT_DOMAIN` | gateway, api, worker | none (gateway refuses to start) | agent apex domain (`lvh.me` dev, e.g. `jinshujuagents.com` prod) |
| `EVELAND_AGENT_URL_SCHEME` | gateway, api, worker | `http` | scheme for minted public URLs (`https` in prod) |
| `EVELAND_AGENT_URL_PORT` | gateway, api, worker | empty (no port suffix) | port for minted public URLs (`8080` in dev) |
| `PORT` | gateway | `8080` | gateway listen port (same convention as the api) |
| `EVELAND_GATEWAY_UPSTREAM_TIMEOUT_MS` | gateway | `30000` | upstream header-phase timeout |
| `EVELAND_GATEWAY_ROUTE_TTL_MS` | gateway | `30000` | route cache TTL |
| `EVELAND_GATEWAY_UPSTREAM_HOST` | gateway | empty | rewrite loopback upstream addresses to this host (containerized gateway on a bridge network); non-loopback `hostAddress` values are never rewritten |

## URL minting

`mintAgentUrl(slug, env)` in `@eveland/shared` returns
`${scheme}://${slug}.${domain}` plus `:${port}` when configured. Three consumers:

1. **worker** — `composeDeploymentEnv` injects
   `WORKFLOW_LOCAL_BASE_URL = mintAgentUrl(project.slug)` into every deployment, with
   the same precedence as `WORKFLOW_POSTGRES_URL`: platform-injected, overridable by a
   project secret of the same name. Dedicated domains carry no path prefix, so
   webhook/callback URL resolution can no longer drop one. When
   `EVELAND_AGENT_DOMAIN` is unset the variable is not injected and a warning is
   logged; nothing else changes.
2. **api** — project JSON responses gain `slug` and `agentUrl` (`null` when the domain
   is not configured); the web app renders it without knowing the config.
3. **gateway** — the discovery endpoint mints each agent's URL.

### Dev loopback patches

- **Agent containers resolving their own domain**: inside a container `lvh.me`
  resolves to the container's own loopback, so workflow callbacks would dial
  themselves. `ProcessStartInput` gains optional `extraHosts`; the worker passes
  `["<slug>.<domain>:host-gateway"]` only when `NODE_ENV !== "production"` and the
  runtime is docker (prod public URLs are `https://…:443` at the ingress — mapping the
  domain straight to the host's plaintext 8080 would be wrong there). The systemd
  adapter ignores the field; host processes use system DNS, which already works.
- **Containerized gateway dialing agents**: in the dev compose the gateway sits on the
  bridge network, where `127.0.0.1:hostPort` (published on the host loopback) is
  unreachable. `EVELAND_GATEWAY_UPSTREAM_HOST=host.docker.internal` (with
  `extra_hosts: host.docker.internal:host-gateway`) rewrites loopback upstreams. The
  prod overlay runs on the host network and doesn't need it.

## Discovery endpoint

`GET /.well-known/eve/agents.json`, served only on the apex host, public:

```json
{
  "agents": [
    { "slug": "md-schedule-demo", "name": "MD Schedule Demo", "url": "https://md-schedule-demo.jinshujuagents.com" }
  ]
}
```

- Contents: every project whose current deployment is running (same predicate as
  routing). Queried directly (no route cache) — it's low-traffic and freshness wins.
- Headers: `cache-control: no-store` and `access-control-allow-origin: *` (public,
  read-only, credential-free — unblocks browser-based eve-chats discovery).
- On agent subdomains the gateway injects **no** CORS headers: with the full domain
  exposed, cross-origin policy belongs to the agent.

## API changes

- `POST /projects` accepts optional `slug` (validated); default auto-generated from
  `name`.
- New `PATCH /projects/:projectId` accepting `{ slug }` only (this iteration):
  validation failure 400, uniqueness conflict 409. The old domain dies immediately.
- Project list/detail responses include `slug` and `agentUrl`.

## Web changes (minimal)

- Project detail page shows `agentUrl` as a clickable external link (hidden when
  `null`).
- A small edit affordance next to the domain updates the slug via PATCH and surfaces
  409 as "already taken". Component shape follows the existing project page style.

## Compose / infra

- **`docker-compose.yml`** (dev): new `gateway` service (`node:24-alpine`, same
  bind-mount + `pnpm --filter @eveland/gateway dev` pattern), publishes `8080:8080`,
  env: `DATABASE_URL`, `EVELAND_AGENT_DOMAIN=lvh.me`, `EVELAND_AGENT_URL_SCHEME=http`,
  `EVELAND_AGENT_URL_PORT=8080`, `EVELAND_GATEWAY_UPSTREAM_HOST=host.docker.internal`
  plus the `extra_hosts` mapping. The worker service gains the three
  `EVELAND_AGENT_*` variables for URL minting.
- **`docker-compose.prod.yml`**: gateway mirrors the api service — `restart:
  unless-stopped`, `network_mode: host`, `NODE_ENV=production` on the run command;
  domain/scheme come from the host `.env`.
- **`infra/systemd/eveland-worker.env.example`** and **`.env.example`**: document the
  `EVELAND_AGENT_*` variables and the gateway section.
- **`docs/deploy/linux.md`**: new gateway section — wildcard DNS + wildcard cert at
  the external ingress, ingress → gateway:8080 plaintext, ingress sets
  `x-forwarded-*`.

## Testing

Pure unit (no sockets, no DB):
- Host normalization/classification: port stripping, casing, trailing dot,
  multi-level rejection, apex match.
- `slugifyProjectName` + slug validation (CJK fallback, truncation, reserved list).
- `mintAgentUrl` with/without port.
- Hop-by-hop filter table; route cache (TTL expiry, negative entries, single-slug
  invalidation, clear-on-reconnect, bounded clear).

In-process integration (real ephemeral-port sockets, fake `RouteSource`, real local
upstream server):
- NDJSON streaming passes through chunk-by-chunk (evidence of no buffering).
- `x-forwarded-*` injection and client-spoofed header stripping.
- Full error-path matrix: 404 / 503 no-deployment / 503 ECONNREFUSED / 502 / 504.
- WebSocket upgrade echo round-trip.
- Discovery endpoint content and headers.

Store and worker unit:
- Both stores: slug generation with conflict retry, `updateProjectSlug` conflict
  error, `recordDeployment` persisting `hostAddress`.
- `composeDeploymentEnv` injecting `WORKFLOW_LOCAL_BASE_URL` (configured/unset domain,
  secret-override precedence).
- Docker adapter `extraHosts` args and the production gate.

Postgres integration (requires `DATABASE_URL`, follows existing integration
conventions):
- Migration backfill correctness (existing rows get unique slugs).
- Trigger → NOTIFY → gateway cache eviction end to end.

## Out of scope (per issue #19)

Multiple live versions / preview domains (`<githash>-<slug>` format already reserved
by the flattened convention), custom domains, gateway-level auth/rate limiting,
cross-node forwarding (schema-ready via `hostAddress`), Public Suffix List submission,
redirects from old slugs.
