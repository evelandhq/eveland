---
title: Install the core services
description: Install a stable Eveland release and run the API, Agent Gateway, Dashboard, Worker, and workflow dispatcher as host systemd units.
---

Stable installations run an exact `vX.Y.Z` tag, not a mutable `main` checkout. Do not deploy `main` as a stable instance.

Every platform process runs on the host as a systemd unit. Docker is left holding the managed OpenTelemetry Collector and, unless you brought your own PostgreSQL, the bundled database.

## Install the selected release

```bash
git fetch --tags origin
git checkout vX.Y.Z
pnpm install --frozen-lockfile
pnpm --filter @evelandhq/web build
pnpm --filter @evelandhq/api db:migrate
```

Apply database migrations before rolling any process onto the new tag. The Dashboard build is a host artifact: `eveland-web.service` serves it and refuses to start without one.

## Configure the platform environment

The installation keeps one configuration file — `/opt/eveland/etc/eveland.env` under `eveland-ctl`, or a local `.env` (gitignored) for a hand-built install. At minimum set the public origin and every production secret:

- `EVELAND_PUBLIC_ORIGIN` — the single browser-visible origin (the front door). The Better Auth URL, the authenticated CORS origin, and the Identity issuer all derive from it; individual overrides (`WEB_ORIGIN`, `BETTER_AUTH_URL`, `EVELAND_IDENTITY_ISSUER`) exist but are rarely needed.
- `EVELAND_IDENTITY_ALLOWED_ORIGINS` — the exact chat browser origin, only with an external chat frontend.
- `EVELAND_AGENT_BASE_DOMAINS` — the wildcard Agent domain, e.g. `agents.example.com`.
- `DATABASE_URL` and `EVELAND_WORKFLOW_WORLD_URL` — one address each, because every reader of them is now a host process in the same network namespace. See [Prepare the host](/docs/production/prerequisites) for bundled versus your own PostgreSQL.
- `BETTER_AUTH_SECRET`, `APP_SECRET_KEY`, `EVELAND_GATEWAY_SERVICE_TOKEN`, `EVELAND_GATEWAY_AFFINITY_SECRET`, `EVELAND_SCHEDULER_RUNTIME_SECRET`, `EVELAND_SCHEDULER_DISPATCH_SECRET`, `EVELAND_OTLP_SERVICE_TOKEN` — long random values, independent of each other. Never reuse the development fallbacks; outside explicit `NODE_ENV=development` the services fail closed without them.

Every variable, default, and consumer is listed in the [environment-variable reference](/docs/reference/environment-variables).

## Start the infrastructure

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d otel-collector postgres
```

Omit `postgres` if this installation uses your own PostgreSQL — it sits behind a Compose profile so a bare `up -d` cannot start a second cluster beside the one you configured.

This starts the **managed OpenTelemetry Collector**, whose Worker-generated configuration is mounted read-only from `/var/lib/eveland/otel`. The Collector stays on its Docker bridge because the Docker runtime attaches it to each Agent's private telemetry network; it reaches the host-native API through `host.docker.internal`, where the API binds a second listener restricted to health, Collector Observation, Agent JWKS, and Scheduler Channel paths.

The overlay starts no platform service at all. The base file's development API, Agent Gateway, Dashboard, Worker, and workflow dispatcher each sit behind a profile this command never enables, so the merged production configuration cannot start a second copy of anything.

**A published `17310` must never be reachable from outside the host.** The bundled database exists so host services — the API, the Agent Gateway, the Worker, the workflow dispatcher, and every deployed Agent process — can reach it on loopback, and it ships with well-known default credentials. Block it from every non-local network at the host firewall — see [Networking](/docs/production/networking).

## Install the platform units

`eveland-ctl install --systemd` renders and enables one unit per platform process:

| Unit                                  | Runs as            | Writes                                   |
| ------------------------------------- | ------------------ | ---------------------------------------- |
| `eveland-api.service`                 | `eveland-platform` | `EVELAND_DATA_DIR`                       |
| `eveland-gateway.service`             | `DynamicUser`      | nothing                                  |
| `eveland-web.service`                 | `eveland-web`      | `apps/web/.next` (its runtime cache)     |
| `eveland-worker.service`              | `root`             | the data root, systemd, deployment users |
| `eveland-workflow-dispatcher.service` | `DynamicUser`      | nothing                                  |

Every listening service runs unprivileged with `ProtectSystem=strict`, a read-only source tree, and an explicit `ReadWritePaths` — and **no two of them share a uid**. That is what makes the per-service environment files a real boundary rather than a convention: same-uid processes can read each other's `/proc/<pid>/environ`, so a public front door sharing the API's user would have had the whole platform configuration one read away. The API and the Dashboard keep fixed users because they own files across restarts; the Gateway owns nothing, so it takes a `DynamicUser` recycled at every boot. The Worker is root on purpose: it is the only component allowed to build untrusted project code and to drive `systemd-run`, `systemctl` and `chown`, which is how each Eve Deployment gets its own unprivileged `DynamicUser`. Each unit reads its own environment file under `etc/`, re-rendered from `etc/eveland.env` on every start — edit that file, not the rendered ones.

For a hand-built install the same units are described in [Install the host Worker](/docs/production/worker) and [Install the workflow dispatcher](/docs/production/workflow-dispatcher).

## Align release identity

Set `EVELAND_RELEASE_CHANNEL=stable` and `EVELAND_REVISION` to the output of `git rev-parse --short=12 HEAD` in the platform configuration, then restart the units. An instance intentionally testing `main` uses `EVELAND_RELEASE_CHANNEL=edge` and its exact revision instead. `eveland-ctl start` and `eveland-ctl update` both pin this from the checkout for you.

The authenticated Dashboard **Settings → About** page compares Dashboard and API build identity; API and Agent Gateway also expose it through their public `/health` responses, Worker prints it on startup, and the dispatcher reports it on its registration. Do not call the installation (or a later upgrade) complete while any of these disagree. Team admins can use the same About page to inspect the allowlisted effective configuration of each component; secrets appear only as a fixed mask.

Next, [install the host Worker](/docs/production/worker).

## Deeper reference

- [Production architecture](/docs/production): supported core services, host Worker, and systemd topology
- [Configuration reference](/docs/reference/configuration): component environment variable ownership and defaults
- [Security model](/docs/operations/security): network isolation, credential protection, and process privilege boundaries
