---
title: Production architecture
description: "Understand Eveland's production topology: core services, host Worker, workflow dispatcher, Agent Gateway, and systemd runtime."
---

Eveland's production architecture is engineered to maximize host agent density while maintaining strict process isolation. In Linux production environments, agents do not run in container-in-container setups; they run directly on the host as hardened, unprivileged **systemd transient units**, managed by a single privileged host Worker.

![Eveland production topology](../../assets/topology-en.svg)

## Topology and responsibilities

| Component               | Execution Model              | Core Role                                                                                               |
| :---------------------- | :--------------------------- | :------------------------------------------------------------------------------------------------------ |
| **API**                 | systemd (unprivileged user)  | Team auth, metadata persistence, source import pipelines, and built-in OTLP projection.                 |
| **Agent Gateway**       | systemd (`DynamicUser`)      | Front door for all public agent traffic: host routing, reverse proxying, and streaming transport.       |
| **Dashboard**           | systemd (unprivileged user)  | Web console for team management and live debugging.                                                     |
| **Worker**              | systemd (`root`)             | Sole privileged controller: manages sandboxed builds and systemd lifecycle. No public network listener. |
| **Workflow Dispatcher** | systemd (`DynamicUser`)      | Singleton external scheduler driving durable timers, wake-ups, and step continuations.                  |
| **Postgres**            | Container or external server | Backing store for platform control plane and shared workflow world (tenant-partitioned).                |
| **OTel Collector**      | Container                    | Managed ingestion and fan-out of OpenTelemetry logs, metrics, and traces.                               |

## Core security principles

### 1. Privilege separation

- **Zero-privilege public edge**: The Agent Gateway only handles traffic forwarding. It holds neither the Docker socket nor host write privileges, and has no access to decrypted database credentials or application secrets.
- **Sandboxed builds**: Although the Worker boots as root to manage system services, untrusted project build scripts (`npm ci`, `npx eve build`) always execute inside an unprivileged bubblewrap sandbox under a dedicated user account.
- **Dynamic user isolation**: Each agent deployment runs under a disposable systemd `DynamicUser`, binding exclusively to private loopback ports (`127.0.0.1:18000–18999`).

### 2. Unified data root

The API and Worker are host-native processes that share a single absolute filesystem root (defaulting to `/var/lib/eveland`). All imported source trees, compiled releases, sandbox caches, and telemetry policies reside under this directory.

### 3. On-demand cold starts and scale-to-zero

Deployments are permanent entities, but running processes are ephemeral:

- When a public request, cron schedule, or workflow step arrives, Eveland activates the target release in milliseconds via an ActivationLease.
- When all leases expire and the idle window lapses (default: 5 minutes), the Worker gracefully terminates the process, reclaiming system memory while leaving routes and session states intact.

Next: [Prepare the host environment](/docs/production/prerequisites).
