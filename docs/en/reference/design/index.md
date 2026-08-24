---
title: Design decisions
description: Why Eveland is built the way it is — the recorded rationale behind the platform's structural choices.
---

These pages record the **why** behind Eveland's structural decisions. The
product boundaries and architecture principles live in the repository's
`spec.md`, the per-domain behavior contracts in this site's reference section,
and the operational truth in the rest of this documentation; this section
explains the reasoning that produced them, distilled from the project's internal planning
records when the platform was opened up in August 2026. Decision zero —
why build Eveland at all — is [Why Eveland](/docs/why).

Two conventions keep these pages honest:

- Every rationale here was actually written down or dictated by the
  maintainers at decision time. Where a choice shipped **without** a recorded
  argument, the page says "recorded as a decision, without a written
  rationale" instead of inventing one after the fact.
- Decisions are presented with the alternatives that were genuinely
  considered and the trade-offs that were knowingly accepted. Costs are
  listed next to benefits.

The one principle that recurs on every page: **the machine exists to serve
Agents, not infrastructure.** Runtime, sandbox, scale-to-zero, and workflow
decisions all optimize for how many useful Agents a single self-hosted box
can run, and for failing closed instead of failing mysteriously.

| Page                                                  | Decision it explains                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| [Runtime](/docs/reference/design/runtime)             | Why production runs on systemd, not Docker                       |
| [Sandbox](/docs/reference/design/sandbox)             | Why Eveland built its own bubblewrap sandbox backend             |
| [Scale to zero](/docs/reference/design/scale-to-zero) | Why Deployments idle-stop and how cold activation is shaped      |
| [Workflow](/docs/reference/design/workflow)           | Why an external dispatcher and a purpose-built Workflow World    |
| [Agent Gateway](/docs/reference/design/gateway)       | The data-plane invariants and what breaks without each           |
| [Observability](/docs/reference/design/observability) | Why OpenTelemetry is the only telemetry transport                |
| [Identity](/docs/reference/design/identity)           | Why Agents see brokered Caller Tokens, never upstream IdP tokens |
| [Agent Catalog](/docs/reference/design/agent-catalog) | Why the Catalog is a projection, and the chat-client contract    |
