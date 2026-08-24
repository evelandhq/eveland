---
title: Configuration
description: Find the production configuration families and the component that owns each value.
---

Use the checked-in `.env.example`, production Compose overlay, and `infra/systemd/eveland-worker.env.example` as the exact configuration surface for your release. This page organizes ownership; it does not replace release-specific defaults. Every variable, default, and reading site is listed in [Environment variables](/docs/reference/environment-variables).

## Core services

Configure public origins, Better Auth, Team bootstrap, Postgres, the shared data root, application encryption, and release identity. Set a cookie domain only when the Dashboard and API intentionally share a parent domain.

## Agent Gateway

Configure Agent base domains, service authentication, affinity signing, the private API origin, and cold-start timeout. Keep Agent Gateway service and affinity secrets independent.

## Worker and runtime

Configure `EVELAND_RUNTIME=systemd`, the same absolute data root, application encryption, app/build users, build sandbox, per-deployment CPU and memory, retention, and `EVELAND_WORKFLOW_WORLD_URL`.

## Workflow dispatcher

Configure the shared workflow database URL, the Control API activation endpoint and token, pool size, concurrency, and maintenance cadence. Use `infra/systemd/eveland-workflow-dispatcher.env.example` as the exact surface; the dispatcher runs as its own systemd service or container and is single-instance per shared database.

## Scheduler and activation

Configure independent runtime and dispatch secrets, the private redeem URL, prewarm duration, activation idle TTL, and recovery/reconciliation batch controls.

## Observability

Configure only the documented OpenTelemetry topology values needed by the deployment. Agent capture, privacy, and external destinations belong to System settings; telemetry degradation must remain separate from Agent-turn success.

Never copy a development fallback into production. Admins can compare the allowlisted effective component configuration under **Settings → About**; secret values remain masked.

## Deeper reference

- [Environment variables](/docs/reference/environment-variables): complete dictionary of platform variable names, defaults, and consumers
- [Production architecture](/docs/production): core services, host Worker, and Dispatcher topology
- [Install the core services](/docs/production/core-services): Compose production environment variable configuration
- [Install the host Worker](/docs/production/worker): Worker systemd environment variable configuration
- [Install the workflow dispatcher](/docs/production/workflow-dispatcher): Dispatcher environment variables and concurrency tuning
