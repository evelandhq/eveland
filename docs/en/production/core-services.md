---
title: Install the core services
description: Install a stable Eveland release and start the Dashboard, API, Agent Gateway, Postgres, and Collector.
---

Stable installations run an exact `vX.Y.Z` tag, not a mutable `main` checkout. Do not deploy `main` as a stable instance.

## Install the selected release

```bash
git fetch --tags origin
git checkout vX.Y.Z
pnpm install --frozen-lockfile
pnpm --filter @evelandhq/api db:migrate
```

Apply database migrations before rolling any API, Agent Gateway, or Worker process onto the new tag.

## Configure the Compose environment

The production overlay reads a local `.env` (gitignored). At minimum set the public origins and every production secret:

- `WEB_ORIGIN`, `NEXT_PUBLIC_API_URL`, `BETTER_AUTH_URL` — the browser-visible Dashboard and API origins. `NEXT_PUBLIC_API_URL` is baked into the Dashboard at build time.
- `EVELAND_IDENTITY_ISSUER`, `EVELAND_IDENTITY_ALLOWED_ORIGINS` — the stable Caller Token issuer and the exact chat browser origin.
- `EVELAND_AGENT_BASE_DOMAINS` — the wildcard Agent domain, e.g. `agents.example.com`.
- `BETTER_AUTH_SECRET`, `APP_SECRET_KEY`, `EVELAND_GATEWAY_SERVICE_TOKEN`, `EVELAND_GATEWAY_AFFINITY_SECRET`, `EVELAND_SCHEDULER_RUNTIME_SECRET`, `EVELAND_SCHEDULER_DISPATCH_SECRET`, `EVELAND_OTLP_SERVICE_TOKEN` — long random values, independent of each other. Never reuse the development fallbacks; outside explicit `NODE_ENV=development` the services fail closed without them.

Every variable, default, and consumer is listed in the [environment-variable reference](/docs/reference/environment-variables).

## Start the core services

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

This starts the Dashboard, API, Agent Gateway, and Postgres with production settings. Two more services come from the base `docker-compose.yml` with no profile gate, so the same command also starts them:

- the **managed OpenTelemetry Collector**, whose Worker-generated configuration is mounted read-only from `/var/lib/eveland/otel`;
- a **containerized workflow dispatcher** carrying the base file's development configuration. The production shared workflow database is driven by the host dispatcher installed in [Install the workflow dispatcher](/docs/production/workflow-dispatcher).

The overlay does not start a containerized Worker; `--profile docker-worker` restores it only for legacy Docker-runtime installs that have not migrated to the host Worker.

API, Agent Gateway, and Dashboard run with host networking so they can reach Deployments on the host's loopback ports; Postgres stays bridged and publishes `5432` to the host. The API container bind-mounts `/var/lib/eveland` at that same absolute path, matching the host Worker's `EVELAND_DATA_DIR` — see the [shared data contract](/docs/production).

**The published `5432` must never be reachable from outside the host.** It exists so host services (Worker, workflow dispatcher) and deployed Agent containers (via `host.docker.internal`) can reach the database, and it ships with well-known default credentials. Block it from every non-local network at the host firewall — see [Networking](/docs/production/networking).

## Align release identity

Set `EVELAND_RELEASE_CHANNEL=stable` and `EVELAND_REVISION` to the output of `git rev-parse --short=12 HEAD` in three places:

- the Compose `.env` (Dashboard, API, Agent Gateway),
- `/etc/eveland/eveland-worker.env` (Worker),
- `/etc/eveland/eveland-workflow-dispatcher.env` (workflow dispatcher).

Restart the Dashboard, API, and Agent Gateway from the core-services checkout, and the Worker and dispatcher from `/opt/eveland`. An instance intentionally testing `main` uses `EVELAND_RELEASE_CHANNEL=edge` and its exact revision instead.

The authenticated Dashboard **Settings → About** page compares Dashboard and API build identity; API and Agent Gateway also expose it through their public `/health` responses, Worker prints it on startup, and the dispatcher reports it on its registration. Do not call the installation (or a later upgrade) complete while any of these disagree. Team admins can use the same About page to inspect the allowlisted effective configuration of each component; secrets appear only as a fixed mask.

Next, [install the host Worker](/docs/production/worker).
