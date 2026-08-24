---
title: Workflow architecture
description: Why durable workflows run through one external dispatcher and a purpose-built shared Workflow World.
---

## Why an external dispatcher

Durable workflows are timers and continuations that must fire _after_ the
process that created them has been idle-stopped. An embedded workflow runner
lives inside the Agent process, so under [scale-to-zero](/docs/reference/design/scale-to-zero)
it dies with it. Eveland therefore runs workflows in external mode only:
Deployments never claim their own workflow jobs, and exactly one Workflow
Dispatcher per installation claims work from Postgres, activates the owning
Deployment through the same internal endpoint the Agent Gateway uses for
cold starts, and POSTs the step back into it.

- Embedded mode is not merely defaulted off — configuring it is a startup
  error. There is no silent fallback.
- "Exactly one" is enforced with a lifetime Postgres advisory lock; a second
  dispatcher fails closed. Restarting is cheap because every claim lives in
  Postgres.
- The dispatcher never loads tenant code and never touches Deployment files:
  Postgres and loopback HTTP only, unprivileged, under its own
  `DynamicUser`.
- A missing or stale dispatcher fails shared builds and `workflow_step`
  activation **closed** (`workflow_unavailable`), because durable work that
  silently never fires is worse than a visible 503.

## Why a purpose-built Workflow World

The upstream `@workflow/world-postgres` package consumes work through fixed
graphile-worker task identifiers. In a multi-project installation that has a
concrete consequence, observed in production as intermittent "model provider
could not load an API key" failures: **any running Eve runtime could claim
any project's queued turn and execute it with its own code and secrets.**
Queue namespaces don't fix it — they change topic prefixes, not the claimed
task id — and upstream boot recovery re-enqueues every project's active runs
unfiltered.

The history has three stages, and the order matters:

1. **One shared upstream database** — produced the cross-project turn
   stealing above.
2. **One physical database per project** — fixed the isolation, at the cost
   of `CREATEDB` privileges, derived-database lifecycle on every launch
   path, and orphaned databases when deletion failed. It also broke down
   when Eve 0.37 added durable task-input callbacks: the callback token is
   opaque to the Gateway, so _all_ Deployments of a Project must see the
   same durable hooks — which per-Deployment-generation databases cannot
   give.
3. **A shared database done right** —
   [`@evelandhq/workflow-world`](https://github.com/evelandhq/workflow-world):
   claiming moved exclusively to the external dispatcher (an Agent cannot
   claim anything, closing the turn-stealing door structurally), tenancy is
   a mandatory column with per-Project partitions, and recovery is
   tenant-filtered. Deployments of one Project intentionally share a world;
   Projects stay isolated.

The world is consumed as a published npm package and injected into immutable
Releases at build time — never patched into `node_modules`, never declared by
Agent source. Eve gates worlds hard: the runtime rejects any world whose
compiled `specVersion` is not the exact number baked into that Eve release,
and neither check is a type error — so a CI contract suite pins the pairing
and an Eve bump fails in CI instead of at deploy time.

Two fail-closed rules round it out: each Release carries an immutable
attestation of the world it was built against (objects with unknown
attestation are refused, not guessed from the current environment), and the
world is a build-time property — it cannot be swapped by changing runtime
environment variables under an executing World.

Development without a configured shared world keeps Eve's local world.
Production use of the local world was never argued against in writing — it
was treated as self-evidently unsuitable (single-process, non-durable under
scale-to-zero).
