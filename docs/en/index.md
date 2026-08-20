---
title: Overview
description: Deploy and operate Eve agents for your team on infrastructure you control.
---

Eveland is a self-hosted deployment and operations platform for teams that already build with [Eve](https://eve.dev). Eve defines the agent; Eveland gives that agent a production home with releases, previews, stable routing, runtime isolation, schedules, and session observability.

## What Eveland owns

```text
Eve project
  → Source revision
  → Immutable release
  → Preview deployment
  → Stable route
  → Sessions, usage, and schedules
```

Eveland does not replace Eve's filesystem-first authoring model or the Agent's own application authentication. It manages what begins after the project is ready to run.

## Production by design

The supported production topology separates the core services from privileged runtime control. The Dashboard, API, Agent Gateway, Postgres, and the managed OpenTelemetry Collector form the core services; a host Worker starts Eve deployments as isolated systemd services, and exactly one Workflow Dispatcher completes the production topology. Agent ports stay on private loopback, while the Agent Gateway owns the stable and preview hosts.

This boundary keeps the Docker controller, source tree, decrypted secrets, and telemetry policy data away from public Agent traffic. Per-deployment CPU and memory limits, idle stopping, and on-demand activation keep runtime capacity intentional.

## Choose your path

- **Platform administrators:** start with [Production architecture](/docs/production), prepare a Linux host, install the core services and Worker, then verify the complete path.
- **Team members:** if Eveland is already installed, follow [Deploy your first agent](/docs/agents/first-deployment).
- **Operators:** use [Runtime and resources](/docs/operations/runtime) and [Health and diagnostics](/docs/operations/diagnostics) for day-two work; [capacity](/docs/operations/capacity), [backup and restore](/docs/operations/backup-restore), and the [environment variable reference](/docs/reference/environment-variables) go deeper.

Local Docker development and repository contribution workflows remain in the repository README. They are not the production deployment path.
