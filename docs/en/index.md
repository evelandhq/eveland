---
title: Overview
description: Self-hosted production infrastructure for running fleets of agents on systems you control.
---

A company will eventually operate more agents than people. Eveland is the infrastructure built for that reality.

Today, Eveland provides self-hosted production infrastructure for agents built with [Eve](https://eve.dev): immutable releases, concurrent preview environments, weighted traffic routing, native runtime isolation, durable scheduling, and end-to-end session observability.

For the core motivation behind self-hosting agent fleets, see [Why Eveland](/docs/why).

## What Eveland owns

```text
Eve project source
  → Source revision
  → Immutable release
  → Preview deployment
  → Stable route
  → Sessions, usage, and schedules
```

Eveland preserves Eve's filesystem-first authoring model and never intervenes in agent-level application auth. Once your agent code is ready to run, Eveland manages its entire deployment and runtime lifecycle.

## Production by design

In production Linux environments, Eveland runs an efficient host-native architecture:

- **Core management services**: API, Agent Gateway, Web Dashboard, and a managed OpenTelemetry Collector handle ingestion, routing, and control.
- **High-density runtime**: A host Worker orchestrates systemd transient services and bubblewrap sandboxes, delivering sub-second cold starts and automatic scale-to-zero when idle.
- **Strict security boundaries**: Public agent traffic flows through the Agent Gateway without access to the host controller, source code, decrypted secrets, or backing databases.

## Choose your path

- **Architects & evaluators**: Read [Why Eveland](/docs/why) for the founding thesis, then dive into [Design decisions](/docs/reference/design) to explore technical trade-offs around runtime density, sandboxing, and scale-to-zero.
- **Agent developers**: If your platform is ready, follow [Deploy your first agent](/docs/agents/first-deployment), then explore [Secrets and Connections](/docs/agents/secrets-connections) and [Releases and traffic routing](/docs/agents/releases-routing).
- **Platform operators & SREs**: Start with [Production architecture](/docs/production), prepare your host with [Host prerequisites](/docs/production/prerequisites), and refer to [Runtime operations](/docs/operations/runtime), [Diagnostics](/docs/operations/diagnostics), and [Troubleshooting](/docs/reference/troubleshooting) for day-two maintenance.

_Note: For local Docker development and repository contribution workflows, see the repository README._
