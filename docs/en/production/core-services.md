---
title: Install the core services
description: Install a stable Eveland release and run the core control plane services as host systemd units.
---

> **Manual installation.** [The installer](/docs/production/install) does everything on this page for you. Follow these steps only if you have to install by hand.

Production deployments should always run a verified stable release tag (e.g. `vX.Y.Z`). Never deploy unverified `main` branch checkouts in production.

On a Linux host, ancillary containers (the managed OTel Collector and optional Postgres) run via Docker, while all core Eveland services run as native systemd units.

## 1. Checkout stable release and build

```bash
git fetch --tags origin
git checkout vX.Y.Z
pnpm install --frozen-lockfile
pnpm --filter @evelandhq/web build
pnpm --filter @evelandhq/api db:migrate
```

_Note: Always apply database migrations (`db:migrate`) before starting or restarting services. The web dashboard artifact (`apps/web/.next`) is served directly by the host unit and must be built beforehand._

## 2. Configure platform environment

For installations managed via `eveland-ctl`, the configuration lives in `/opt/eveland/etc/eveland.env`; for manual setups, use `.env` in the repository root. Core required variables include:

```ini
# Public front door origin (no trailing slash)
EVELAND_PUBLIC_ORIGIN=https://console.example.com

# Wildcard base domain for agent routing
EVELAND_AGENT_BASE_DOMAINS=agents.example.com

# Database connection strings
DATABASE_URL=postgres://eveland:password@127.0.0.1:17310/eveland
EVELAND_WORKFLOW_WORLD_URL=postgres://eveland:password@127.0.0.1:17310/eveland

# Security secrets (generate long, distinct random strings using openssl rand -hex 32)
BETTER_AUTH_SECRET=your_auth_secret_32_bytes_min
APP_SECRET_KEY=your_app_encryption_key_32_bytes
EVELAND_GATEWAY_SERVICE_TOKEN=your_gateway_service_token
EVELAND_GATEWAY_AFFINITY_SECRET=your_affinity_secret
EVELAND_SCHEDULER_RUNTIME_SECRET=your_scheduler_runtime_secret
EVELAND_SCHEDULER_DISPATCH_SECRET=your_scheduler_dispatch_secret
EVELAND_OTLP_SERVICE_TOKEN=your_otlp_service_token
```

_For all options and defaults, see the [Environment variable reference](/docs/reference/environment-variables)._

## 3. Start infrastructure containers

Launch the managed OpenTelemetry Collector (and bundled Postgres):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d otel-collector postgres
```

_(Omit `postgres` if you are connecting to your own external PostgreSQL cluster)._

**Security Warning**: The bundled Postgres port `17310` is intended exclusively for loopback access by host processes. **Never expose port 17310 on your public firewall**.

## 4. Install and configure systemd units

Platform services run with least-privilege system isolation:

| Unit                                  | User Identity                     | Role & Writable Paths                                    |
| :------------------------------------ | :-------------------------------- | :------------------------------------------------------- |
| `eveland-api.service`                 | `eveland-platform` (unprivileged) | Control plane API; writes only to `EVELAND_DATA_DIR`     |
| `eveland-gateway.service`             | `DynamicUser` (unprivileged)      | Public entry gateway; read-only filesystem               |
| `eveland-web.service`                 | `eveland-web` (unprivileged)      | Dashboard console; writes only to `.next` runtime cache  |
| `eveland-worker.service`              | `root` (host controller)          | Sandboxed build and process orchestrator; no public port |
| `eveland-workflow-dispatcher.service` | `DynamicUser` (unprivileged)      | External workflow scheduler; read-only filesystem        |

When using `eveland-ctl`, install and enable all units with one command:

```bash
eveland-ctl install --systemd
```

For manual service configuration, see [Install the host Worker](/docs/production/worker) and [Install the workflow dispatcher](/docs/production/workflow-dispatcher).

## 5. Verify release alignment

After starting the services, log into the dashboard and navigate to **Settings → About**:

- Confirm that API, Dashboard, Worker, and Dispatcher report matching `version` and `revision` strings.
- Verify that all services report `channel: stable`.

Next: [Install the host Worker](/docs/production/worker).

## Deeper reference

- [Production architecture](/docs/production): supported core services, host Worker, and systemd topology
- [Configuration reference](/docs/reference/configuration): component environment variable ownership and defaults
- [Security model](/docs/operations/security): network isolation, credential protection, and process privilege boundaries
