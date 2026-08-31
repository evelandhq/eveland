---
title: Production architecture
description: Understand the supported core services, host Worker, workflow dispatcher, Agent Gateway, and systemd runtime topology.
---

Eveland's production boundary is intentionally different from its local development stack. Production Eve deployments do not run through the development Docker runtime: they run as unprivileged systemd units on the host, controlled by a single privileged Worker.

![Eveland production topology](../../assets/topology-en.svg)

## Core services

The Dashboard, API, Agent Gateway, Postgres, the managed OpenTelemetry Collector, and a containerized workflow dispatcher run in Docker Compose with the production overlay. API owns authenticated team workflows and persistence. The Agent Gateway is the only public Agent data plane and has neither the Docker socket nor access to sources, Releases, secrets, or Collector configuration; the Compose stack masks the data directory from it. The overlay does not start a containerized Worker — that container exists only behind `--profile docker-worker` for legacy Docker-runtime installs.

## Host runtime controller

Worker runs directly on the Linux host as a root-owned systemd service. It is the only component allowed to build untrusted project code and control systemd units (`systemd-run`, `systemctl`, `chown`). Builds run as a separate unprivileged build user inside a bubblewrap sandbox; each Eve Deployment runs under its own systemd `DynamicUser` and binds a private `127.0.0.1:41xxx` port. Worker has no public listener.

## Workflow dispatcher

Durable workflows run in external mode: Deployments never claim their own timers. Exactly one workflow dispatcher runs alongside Worker, claims durable workflow jobs from the shared workflow database, and POSTs each step back into the owning Deployment — activating it first when it has been idle-reaped. Without this process, durable timers, wake, and continuation never fire. See [Install the workflow dispatcher](/docs/production/workflow-dispatcher).

## Shared data contract

API and Worker must see the same absolute data root, normally `/var/lib/eveland`; the API container bind-mounts it at that exact host path. A Project's stored `sourcePath` is written by whichever side imports the Project and read by whichever side later serves or deploys it, so a mismatched mount leaves one side unable to find files the other wrote. Imported sources, prepared Releases, Agent observability policies, managed Collector configuration, and sandbox caches all live below this root.

## Telemetry topology

The managed Collector publishes its service-authenticated platform receiver on host loopback ports 17311/17312 and its Agent receiver on 17313/17314. systemd Agents reach host loopback port 17314; each active Docker Deployment instead gets a private network containing only its Agent and the Collector. Never publish either receiver on a public interface.

The Agent receiver is unauthenticated, so each Deployment's telemetry is attributed by a Worker-signed credential written into its read-only `agent-policy.json`; the platform verifies it and replaces Agent-supplied ownership with the Store-owned Deployment identity. Different Agent Deployments cannot resolve or connect to one another through the telemetry path. A missing Collector degrades telemetry but never blocks an Agent start or cold activation, and observability settings changes restart only the Collector, never Agent Deployments.

## Public entry points

Everything enters through the Agent Gateway front door on host port `17300`, behind your TLS reverse proxy: the Dashboard and browser API on the platform host (`EVELAND_PUBLIC_ORIGIN`), Agent traffic on wildcard Agent hosts. Deployment ports stay on loopback. See [Configure Agent traffic](/docs/production/networking).

## Resource lifecycle

A durable Deployment is not the same thing as a permanently running process. Activation leases wake the exact Release for traffic, continuations, or schedules. After the final lease, Worker stops the RuntimeInstance following the configured idle period while the Deployment, preview address, and SessionBindings remain valid.

systemd Deployment processes are transient units and do not restart automatically after a host reboot. The enabled Worker does restart, reconciles stale RuntimeInstances, and the next request or schedule cold-starts the preserved exact Release; only the transient process is absent during the cold interval.

Continue with [Prepare the host](/docs/production/prerequisites).
