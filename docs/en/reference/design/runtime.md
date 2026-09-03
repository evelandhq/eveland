---
title: Why systemd, not Docker
description: Production runs Agents as hardened systemd units because the machine's resources should serve Agents, not infrastructure.
---

## The decision

Production Eveland runs every Deployment as a hardened systemd transient unit
on the Linux host, controlled by a root Worker. Docker is the development
runtime (and a legacy opt-in profile), not a production choice.

## The reason: density

The goal is to squeeze the machine for the Agents. In a real installation the
number of Agents easily exceeds the number of people using them, so the
economics are set by how many Agents one box can host — and every byte and
cycle the infrastructure consumes is capacity an Agent doesn't get.

Docker charges for itself twice: the daemon is a permanent resident, and
every Deployment carries an image whose layers occupy disk even when nothing
is running. A systemd transient unit costs nothing when it isn't running, and
a Release is just a directory of files — no image build, no layer store, no
per-Deployment baseline. Combined with [scale-to-zero](/docs/reference/design/scale-to-zero)
and the [bubblewrap sandbox](/docs/reference/design/sandbox), the marginal
cost of one more _dormant_ Agent approaches zero, so the same machine runs
strictly more Agents on systemd than it would on containers.

Secondary reasons recorded at decision time:

- **Privilege lives in exactly one place.** The Worker is root on purpose —
  it drives `systemd-run`, `systemctl`, and ownership handoffs — while every
  deployed Agent runs unprivileged under its own `DynamicUser`. No component
  except the Worker holds host privileges; the API and Agent Gateway cannot
  start processes at all.
- **Host processes need no network plumbing.** A containerized Agent that
  calls a host-local model server (Ollama) needs an injected loopback bridge;
  a host process just binds loopback. The systemd adapter deleted a layer the
  Docker adapter had to punch through.

## What Docker remains for

Local development — `docker-compose.yml` pins `EVELAND_RUNTIME: docker` so
macOS development works unchanged — and the macOS appliance, where
`eveland-ctl` runs the stack on Docker Desktop and systemd does not exist.
Linux production supports the systemd runtime only; there is no Docker Agent
runtime to opt into there. Linux native development keeps the Collector
bridged because the Docker runtime attaches it to each Agent's private telemetry
network. The host API therefore adds a second listener on Docker's private bridge
address, restricted to health, Collector Observation, Agent JWKS, and Scheduler
Channel paths; its control plane remains loopback-only. Core platform services
(Postgres, the OTel Collector) stay containerized in production; it is the
_Agent_ runtime that moved to the host.

## Mixed runtimes: visible, not supported

Every Deployment records the `runtimeKind` that created it, and lifecycle
operations resolve their adapter from that recorded value — never from the
Worker's current configuration. The recorded reason is deliberately narrow:
the column's job is "to make mixed state visible and stoppable, not to make
mixed hosts a supported topology." Stopping a Deployment whose runtime isn't
available on this host fails loudly as a logged job failure, never silently.

## Build de-privileging

The build step (`npm ci`, `npx eve build`) executes arbitrary third-party
lifecycle scripts. The adversary in the threat model is the dependency tree,
not the project author, so builds run as a dedicated unprivileged build user
inside the same bubblewrap mask; root only choreographs ownership handoffs
between the build user and the app user. Skipping the sandbox
(`EVELAND_BUILD_SANDBOX=none`) exists but is explicitly not recommended.

## Accepted trade-offs

- Linux-only production, and the Worker runs as root.
- Resource limits are coarse: one global memory/CPU cap applies to all
  Deployments rather than per-tenant budgets.
- Secrets reach Agents as root-owned `0600` environment files rather than
  systemd `LoadCredential`, because Eve apps read `process.env` — env-file
  injection is drop-in parity with `docker --env` and requires no app-side
  changes.
- The shared data root `/var/lib/eveland` becomes a hard cross-service
  contract: every platform process reads it at that one absolute path, so a
  stored source path resolves the same for the API that wrote it and the
  Worker that later builds from it.

## Deeper reference

- [Production architecture](/docs/production): core services and host Worker topology overview
- [Install the host Worker](/docs/production/worker): systemd service setup and environment configuration
- [Why a bubblewrap sandbox](/docs/reference/design/sandbox): build and runtime sandbox isolation decisions
- [Scale to zero](/docs/reference/design/scale-to-zero): zero-cost dormant agents and cold activation mechanics
