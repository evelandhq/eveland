---
title: Install the workflow dispatcher
description: Install the singleton external workflow dispatcher driving durable timers, wake-ups, and step continuations.
---

> **Manual installation.** [The installer](/docs/production/install) does everything on this page for you. Follow these steps only if you have to install by hand.

In production environments, Eveland executes durable workflows in external mode. Agent deployments do not claim their own workflow jobs; **exactly one Workflow Dispatcher instance must run per installation**, claiming pending tasks from the database and waking target agents on demand.

## 1. Role and operational model

- **Job claiming and wake-up**: The dispatcher polls the shared workflow database for due timers and execution steps, wakes dormant agent instances via the Control API (if idle-reaped), and posts the step to the agent.
- **Singleton enforcement**: The dispatcher maintains a continuous PostgreSQL advisory lock throughout its lifetime, ensuring mutual exclusion across the cluster. Restarts are idempotent and never drop queued jobs.
- **Zero tenant code exposure**: The dispatcher communicates exclusively with the database and internal HTTP endpoints under an unprivileged `DynamicUser`, never loading tenant code or decrypting application secrets.

## 2. Install and start systemd service

The dispatcher runs from `/opt/eveland`, sharing code with the Worker:

```bash
sudo install -d -m 0750 /etc/eveland
sudo cp infra/systemd/eveland-workflow-dispatcher.env.example /etc/eveland/eveland-workflow-dispatcher.env
sudo cp infra/systemd/eveland-workflow-dispatcher.service /etc/systemd/system/
```

Configure the environment file, reload systemd, and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eveland-workflow-dispatcher
```

## 3. Configure environment variables

In `/etc/eveland/eveland-workflow-dispatcher.env`, ensure the following values align with your platform configuration:

```ini
# Shared workflow database (must match the URL injected into deployments)
EVELAND_WORKFLOW_WORLD_URL=postgres://eveland:password@127.0.0.1:17310/eveland_workflow

# Internal Control API address and token (used to wake dormant agents)
WORKFLOW_DISPATCHER_ACTIVATION_API_URL=http://127.0.0.1:17301
WORKFLOW_DISPATCHER_ACTIVATION_TOKEN=your_api_service_token

# Scheduler dispatch secret (must match Worker)
EVELAND_SCHEDULER_RUNTIME_SECRET=your_scheduler_runtime_secret

# Telemetry and release identity
EVELAND_OTLP_ENDPOINT=http://127.0.0.1:17311
EVELAND_OTLP_SERVICE_TOKEN=your_otlp_service_token
NODE_ENV=production
EVELAND_RELEASE_CHANNEL=stable
EVELAND_REVISION=your_git_commit_sha
```

_Note: Ensure `WORKFLOW_DISPATCHER_LEASE_RENEW_INTERVAL_MS` is significantly lower than `EVELAND_ACTIVATION_LEASE_TTL_MS` so long-running steps renew their execution leases before timing out._

## 4. Verify dispatcher operation

Inspect the journal output:

```bash
sudo journalctl -u eveland-workflow-dispatcher -f
```

- When successfully initialized, the dispatcher logs `workflow-dispatcher: ready`.
- The process continuously reports heartbeat registrations to the Control API.
- Verify in the dashboard under **Settings → Instance health** that Workflow Dispatch reports an active, healthy status.

Next: [Configure Agent traffic and reverse proxying](/docs/production/networking).

## Deeper reference

- [Workflow architecture design decisions](/docs/reference/design/workflow): rationale behind external dispatch and shared workflow world
- [Runtime and resources](/docs/operations/runtime): durable workflow world tenant partitioning and retention classes
- [Configuration reference](/docs/reference/configuration): dispatcher tuning knobs and concurrency limits
