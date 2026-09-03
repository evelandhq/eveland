---
title: Install the core services
description: Install a stable Eveland release and start the Dashboard, API, Agent Gateway, and Collector against your external Postgres.
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
- `DATABASE_URL`, `EVELAND_WORKFLOW_WORLD_URL` — the two databases on the [external Postgres](/docs/production/prerequisites#provision-an-external-postgres). Both must be dialable exactly as written from the Compose network **and** from the host, because the host Worker, the dispatcher, and every Deployment use the same strings; a host loopback address is the API container's own loopback and does not qualify. Quote both values (`DATABASE_URL='postgres://…'`): Compose expands `$NAME` inside an unquoted `--env-file` value, so a password containing `$` reaches the API container truncated while every host process gets it intact.
- `BETTER_AUTH_SECRET`, `APP_SECRET_KEY`, `EVELAND_GATEWAY_SERVICE_TOKEN`, `EVELAND_GATEWAY_AFFINITY_SECRET`, `EVELAND_SCHEDULER_RUNTIME_SECRET`, `EVELAND_SCHEDULER_DISPATCH_SECRET`, `EVELAND_OTLP_SERVICE_TOKEN` — long random values, independent of each other. Never reuse the development fallbacks; outside explicit `NODE_ENV=development` the services fail closed without them.

Every variable, default, and consumer is listed in the [environment-variable reference](/docs/reference/environment-variables).

## Start the core services

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

This starts the Dashboard, API, and Agent Gateway with production settings, plus the **managed OpenTelemetry Collector** from the base `docker-compose.yml`, whose Worker-generated configuration is mounted read-only from `/var/lib/eveland/otel`.

Postgres is not among them. The base file's development database sits behind a profile this command never enables, because this topology takes Postgres as an [external prerequisite](/docs/production/prerequisites#provision-an-external-postgres): the API is on the Compose bridge while the Worker, the dispatcher, and every Deployment are on the host, and only an instance outside the installation has one address all three can dial. A Compose database here would be a second cluster nobody notices — the shape in which a Deployment writes runs into a database the dispatcher never claims from.

The base file's containerized workflow dispatcher carries development configuration, so the overlay gates it behind a profile this command never enables. Each installation runs exactly one dispatcher: in production that is the host dispatcher installed in [Install the workflow dispatcher](/docs/production/workflow-dispatcher).

The overlay starts no Worker at all. Production Agents run as hardened systemd units under the host Worker installed in [Install the host Worker](/docs/production/worker), and the base file's development Worker sits behind a profile this command never enables — so the merged production configuration cannot start a second runtime controller.

Agent Gateway and the Dashboard run with host networking so the front door can reach Deployments on the host's loopback ports. The API stays on the Compose network: it dials no Deployment port, and the Collector has to reach it to deliver every Agent event, which only a shared network allows. It publishes one loopback-only host port, `17301`, so the host Worker, the workflow dispatcher, and the front door can dial it. The API container bind-mounts `/var/lib/eveland` at that same absolute path, matching the host Worker's `EVELAND_DATA_DIR` — see the [shared data contract](/docs/production).

**Reaching the external database is now a network question, not a published port.** The instance has to accept connections from this host on whatever address `DATABASE_URL` names, and it must not be reachable from the public internet: keep it on a private network or a security group that admits only this host — see [Networking](/docs/production/networking).

## Align release identity

Set `EVELAND_RELEASE_CHANNEL=stable` and `EVELAND_REVISION` to the output of `git rev-parse --short=12 HEAD` in three places:

- the Compose `.env` (Dashboard, API, Agent Gateway),
- `/etc/eveland/eveland-worker.env` (Worker),
- `/etc/eveland/eveland-workflow-dispatcher.env` (workflow dispatcher).

Restart the Dashboard, API, and Agent Gateway from the core-services checkout, and the Worker and dispatcher from `/opt/eveland`. An instance intentionally testing `main` uses `EVELAND_RELEASE_CHANNEL=edge` and its exact revision instead.

The authenticated Dashboard **Settings → About** page compares Dashboard and API build identity; API and Agent Gateway also expose it through their public `/health` responses, Worker prints it on startup, and the dispatcher reports it on its registration. Do not call the installation (or a later upgrade) complete while any of these disagree. Team admins can use the same About page to inspect the allowlisted effective configuration of each component; secrets appear only as a fixed mask.

Next, [install the host Worker](/docs/production/worker).

## Deeper reference

- [Production architecture](/docs/production): supported core services, host Worker, and systemd topology
- [Configuration reference](/docs/reference/configuration): component environment variable ownership and defaults
- [Security model](/docs/operations/security): network isolation, credential protection, and process privilege boundaries
