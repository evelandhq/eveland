---
title: Why Eveland
description: Run 100 agents in your own infrastructure.
---

**Run 100 agents in your own infrastructure.**

This is Eveland's core purpose: enabling teams to operate fleets of agents at organizational scale, directly inside the infrastructure and data environments they already control.

## A hundred agents, not one

An organization that takes agents seriously does not end up with _an_ agent.
Repetitive work exists in every function — support, marketing, back office,
finance — and each pocket of it justifies its own agent. The steady state is
more agents than people.

That ratio breaks tools built for the singular case. A deployment
pipeline per agent, a login page per agent, a chat frontend per agent, a
monitoring dashboard per agent — none of it survives multiplication by a
hundred. Eve's default self-hosting story runs one node with one agent: it is a
fine way to run _an_ agent, but no way to run a fleet. Eveland is built for
the plural from day one. Import a project, and deployment, routing,
secrets, schedules, identity, chat, and observability are already there:
shared once across the platform, not rebuilt per agent.

This focus on the plural is why the platform optimizes for
[density](/docs/reference/design/runtime): when a hundred agents share a
single box, every resource the infrastructure consumes is an agent you cannot run.

## In your infrastructure, not someone else's

"Data sovereignty" is the broad strategic argument, but the day-to-day reality is even more direct: **your agents are only useful where your systems are.**
SaaS applications can live in the cloud, but no enterprise has everything in
the cloud: finance data, operational data, self-hosted internal
applications. Agents that cannot reach those systems cannot do the work, and
forcing internal systems to migrate onto a hosted platform is a cost measured in
years, when it is possible at all. This is not a regional quirk;
heterogeneous, partly-on-premises system landscapes are the global
enterprise reality. Eveland goes to where the data already lives.

Then there is cost, in two currencies:

- **Running cost.** LLM calls, workflow state, sandbox execution: on a
  hosted platform, each is a metered line item. On your own hardware, they use
  capacity you already own, and the platform is engineered to waste none of
  it. With [systemd runtime density](/docs/reference/design/runtime),
  [lightweight bubblewrap sandboxing](/docs/reference/design/sandbox),
  [on-demand activation and scale-to-zero](/docs/reference/design/scale-to-zero),
  and [external workflow dispatching](/docs/reference/design/workflow), a modest
  machine comfortably hosts dozens of production agents.
- **Management cost.** Hosted deployment platforms are built for operators;
  business stakeholders cannot see what an agent actually did. Eveland gives
  development, operations, and business the same clear window: Sessions,
  reasoning traces, tool calls, schedules, and usage are first-class, human-readable
  surfaces — not opaque logs to export on request. The foundation is
  guaranteed by a [transparent OpenTelemetry pipeline](/docs/reference/design/observability)
  and a [secure Agent Gateway](/docs/reference/design/gateway).

## Where Eveland came from

The road to agents that genuinely run on their own is long, and we walked
most of it: frameworks that could not run unattended, runners that were
unstable and untraceable on failure, and several stops in between.
[Eve](https://eve.dev) is the first framework that matches what we were
looking for: agents as code, traceable execution, stable runtime behavior, LLM- and
cloud-agnostic, fit for running at organizational scale. Eveland is the missing production
half: everything between "the agent works locally" and "the organization runs on
it in production."

This is not a speculative design. [Jinshuju](https://jinshuju.net) runs 20+
agents on Eveland — customer support, marketing, back office, finance — in
continuous stable operation for over two months. Most of the recorded
[design decisions](/docs/reference/design) were forced by that production
reality, not imagined ahead of it.

## Who it's for

Any team with repetitive operational workflows. Writing an agent takes basic development
ability, but with today's coding agents that bar keeps dropping — a
one-person company may benefit the most: agents that work while you sleep.

Against office chat assistants, the difference is unattended autonomy:
Eveland agents run on schedules, wake on webhooks and channels, and don't
need a human in the loop to exist. Against DIY agent runners, the
difference is that boring word: production. Stable execution, hardened isolation,
first-class observability, and deterministic recovery when something goes wrong.

If that is the problem you have, [deploy the platform](/docs/production) and
give your first hundred agents a home.
