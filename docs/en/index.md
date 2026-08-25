---
title: Overview
description: Self-hosted production infrastructure for agents on systems you control.
---

A company will eventually operate more agents than people. Eveland is the infrastructure for that world.

Today, Eveland starts with self-hosted production infrastructure for [Eve](https://eve.dev) agents: giving your fleet a production home with immutable releases, concurrent previews, stable traffic routing, runtime isolation, durable schedules, and transparent session observability. The founding argument — why run agents on your own infrastructure at all — is in [Why Eveland](/docs/why).

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

- **Architects and evaluators:** start with [Why Eveland](/docs/why) for the founding argument, and explore [Design decisions](/docs/reference/design) for detailed trade-offs behind runtime density, bubblewrap sandboxing, scale-to-zero, and gateway design.
- **Agent developers and team members:** if Eveland is already installed, follow [Deploy your first agent](/docs/agents/first-deployment), then explore [Secrets and Connections](/docs/agents/secrets-connections), [Releases and traffic routing](/docs/agents/releases-routing), [Sessions and usage tracking](/docs/observe/sessions), and [Schedules and automation](/docs/observe/schedules).
- **Platform administrators:** start with [Production architecture](/docs/production), prepare a Linux host, install the core services, host Worker, and Workflow Dispatcher, then verify the complete path.
- **Operators and SREs:** use [Runtime and resources](/docs/operations/runtime), [Health and diagnostics](/docs/operations/diagnostics), and [Troubleshooting](/docs/reference/troubleshooting) for day-two operations; [Capacity planning](/docs/operations/capacity), [Upgrades](/docs/operations/upgrades), [Backup and restore](/docs/operations/backup-restore), and the [Environment variable reference](/docs/reference/environment-variables) cover deeper production scenarios.

Local Docker development and repository contribution workflows remain in the repository README. They are not the production deployment path.
