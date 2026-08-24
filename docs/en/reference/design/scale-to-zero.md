---
title: Scale to zero
description: Deployments are durable addresses; processes are disposable. Everything else follows from splitting the two.
---

## The decision

A Deployment is a durable, addressable, immutable target. The operating
system process behind it is disposable: it idle-stops five minutes after the
last piece of live work, and anything that needs it running — a public
request, an active stream, a running turn, a schedule dispatch, a workflow
step — must hold a time-bounded activation lease. A durably parked Session
does **not** keep a process alive.

This is the second half of the [density argument](/docs/reference/design/runtime):
systemd makes a dormant Agent cost almost nothing, and scale-to-zero makes
dormancy the default state.

## Cold activation: the privilege split

The component that notices dormancy never gains host privilege:

1. The Agent Gateway detects that the selected Deployment is dormant.
2. It calls a service-authenticated internal activation endpoint.
3. The API enqueues (and coalesces) the activation job — it holds no Docker
   or systemd privileges.
4. The Worker — the only privileged component — starts the prebuilt Release
   and publishes readiness. A cold start never reinstalls dependencies or
   rebuilds source.
5. The Gateway waits inside a bounded cold-start budget, then proxies with
   the original auth, headers, body stream, abort signal, and NDJSON
   response stream intact.

Session pinning survives dormancy: a continuation wakes the Deployment the
SessionBinding already selected; it never re-runs route weighting.

## Why the platform owns the cron clock

Eve runs its schedule timer in-process, which collides with both halves of
the design: a dormant process has no clock, and with preview and A/B
Deployments running concurrently _every alive process gets its own clock_ —
previews would independently execute production business schedules.

So prepared Releases keep schedule registrations for Eve compatibility but
replace their native handlers with no-ops; only Eveland's authenticated
dispatch path invokes the preserved original definition. Eveland owns the
clock and the ScheduleRun ledger in Postgres; the injected Scheduler Channel
is an execution RPC inside a temporarily woken process, not a daemon. Cron
targets exactly one Deployment — never a weighted Gateway route — so previews
and candidates don't run business cron merely because they exist. A Worker
restart rediscovers due work from Postgres; in-memory timers are only wakeup
hints. Missed ticks coalesce into at most one catch-up run with a recorded
missed count, never an unbounded replay.

## Accepted trade-offs

- **Cold-start latency is real and bounded.** The Gateway waits up to a
  configured budget (30 s default) and the request either proceeds or fails
  visibly; the inbound body stays backpressured rather than buffered while
  waiting.
- **At-least-once, not exactly-once.** Eveland guarantees one durable
  ScheduleRun per due tick and idempotent dispatch claiming; authored side
  effects still need their own idempotency. A dispatch whose outcome is
  unknowable lands in a terminal `dispatch_unknown` state with an audited
  operator retry — never an automatic replay.
- **A dispatch is not an execution.** A schedule dispatch that returns
  Session IDs holds its lease until every returned Session reports a root
  turn boundary; the five-minute idle TTL is an activation timeout, not an
  execution timeout.
- **Readiness must prove port ownership.** A later-discovered hazard, now an
  invariant: readiness verifies the listening socket belongs to the process
  the Worker started, so the Gateway can never proxy traffic to a stranger
  that grabbed the port.

## Deeper reference

- [Why systemd, not Docker](/docs/reference/design/runtime): runtime density and marginal cost of dormant agents
- [Routing and Deployment lifecycle contract](/docs/reference/routing): activation leases, port reservation, and cold starts
- [Schedules and automation](/docs/observe/schedules): developer guide to schedule execution and prewarming
- [Scheduling behavior contract](/docs/reference/scheduling): planner state machine, prewarming, and execution boundaries
