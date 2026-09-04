---
title: Why Eveland
description: A company will eventually operate more agents than people. Eveland is the infrastructure built for that reality.
---

> **A company will eventually operate more agents than people.**
>
> **Eveland is the infrastructure built for that reality.**

Today, Eveland delivers self-hosted, production-grade infrastructure for Eve agents: empowering organizations to operate agent fleets at scale, directly within their own infrastructure and data environments.

## Operating a hundred agents, not just one

Organizations that embrace agents in earnest never stop at a single assistant. Repetitive workflows exist in every department — customer support, marketing, operations, and finance. Every domain justifies dedicated agents. In a mature state, an organization will operate more agents than employees.

This volume quickly breaks tooling designed for one-off deployments. Maintaining a bespoke deployment pipeline, login screen, chat UI, and monitoring dashboard per agent simply does not scale when multiplied by a hundred.

Eveland was engineered for the plural from day one. Import a project, and deployments, domain routing, secrets management, scheduled automation, user identity, and full observability are immediately available — shared at the platform level rather than rebuilt per agent. This is also why Eveland relentlessly optimizes for [runtime density](/docs/reference/design/runtime): when dozens of agents share a machine, every resource consumed by infrastructure overhead is capacity lost for running actual agents.

## On your infrastructure, close to your data

Beyond data sovereignty and compliance, engineering reality dictates that **agents are only valuable when they can directly reach your systems.**

Few organizations host all their core assets exclusively in public clouds. Internal financial databases, operational data stores, and proprietary enterprise applications frequently reside in on-premises or private network environments. Forcing those systems to migrate onto third-party hosted platforms is expensive and slow. Eveland brings the agent runtime directly to where your data already lives.

Self-hosting also delivers compelling cost advantages across two dimensions:

- **Operational expenditure**: On managed platforms, LLM gateway calls, durable workflow state storage, and sandbox compute are recurring metered line items. On your own hardware, these utilize existing capacity. Powered by [systemd host-native runtime density](/docs/reference/design/runtime), [lightweight bubblewrap sandboxing](/docs/reference/design/sandbox), [on-demand cold activation and scale-to-zero](/docs/reference/design/scale-to-zero), and [external workflow dispatching](/docs/reference/design/workflow), a modest cloud VM can easily host dozens of production agents.
- **Observability and transparency**: Managed platforms often present black-box dashboards tailored for DevOps, leaving business owners blind to what an agent actually did. Eveland provides developers, operators, and business stakeholders with a unified view: conversation trees, reasoning traces, tool executions, schedules, and token usage are first-class, human-readable interfaces, backed by a [transparent OpenTelemetry pipeline](/docs/reference/design/observability) and an [isolated Agent Gateway](/docs/reference/design/gateway).

## Origins of Eveland

The journey to building autonomous agents that run reliably without human supervision is demanding. We encountered frameworks that could not run unattended, task runners that failed silently without tracebacks, and various fragile orchestration scripts.

[Eve](https://eve.dev) was the first open-source framework that matched our expectations: agents written as standard code, deterministic execution, multi-model flexibility, and enterprise maintainability. Eveland provides the missing production layer: bridging the gap between "runs on my laptop" and "reliably powers our enterprise in production."

This architecture was forged in real operations. [Jinshuju](https://jinshuju.net) runs 20+ agents on Eveland — spanning customer support, growth, administration, and finance — in continuous, stable production for months. Most of our [design decisions](/docs/reference/design) were shaped by concrete operational realities rather than theoretical speculation.

## Who it's for

- **Teams with repetitive operational workflows**: AI coding tools have made authoring domain agents remarkably accessible. Even solo developers and small teams can deploy an autonomous digital workforce that works around the clock.
- **Teams requiring production determinism**: Unlike simple chat widgets, Eveland agents execute autonomously via cron schedules, webhooks, and asynchronous message channels. Unlike brittle experimental runners, Eveland enforces strict process isolation, deterministic crash recovery, and enterprise-grade observability.

If you are ready to put your agent fleet into production, explore [Production deployment](/docs/production) and build a reliable home for your agents.
