---
title: Scale to zero
description: Deployments are durable addresses; processes are disposable. Everything else follows from splitting the two.
---

## The Decision

In Eveland, **a Deployment is a durable, addressable, immutable entity, whereas its underlying operating system process is completely disposable**.

Five minutes after the last active work finishes, the Worker gracefully stops the process. Any action that requires the agent to run (public requests, active streams, ongoing turns, cron dispatches, or workflow steps) must acquire a time-bounded activation lease.

This represents the foundational pillar of the [runtime density argument](/docs/reference/design/runtime): systemd makes dormant agents virtually zero-cost, and scale-to-zero makes dormancy the default steady state.

---

## Cold Activation: The Privilege Split

When a request arrives for a dormant agent, cold activation follows strict privilege separation:

```text
1. Public request arrives at Agent Gateway; targets a dormant (stopped) deployment
2. Gateway invokes an internal, service-authenticated activation endpoint
3. Control Plane API coalesces and enqueues the activation task (API holds no system privileges)
4. Host Worker claims the task, launches the pre-compiled exact Release, and verifies socket ownership
5. Gateway waits within a bounded timeout budget (default: 30s) and transparently proxies traffic
```

Cold starts run pre-compiled artifacts directly from disk, **never reinstalling dependencies or recompiling code**, completing in milliseconds to seconds.

---

## Why the Platform Owns the Cron Clock

Eve framework executes schedule timers in-process by default. In enterprise multi-version environments, this causes serious conflicts:

1. **Dormant processes have no clock**: Stopped processes cannot trigger scheduled timers;
2. **Duplicate executions across previews**: When preview deployments or canary targets run concurrently, each process fires duplicate cron tasks, risking duplicated business mutations.

Eveland neutralizes local cron handlers during compilation, centralizing schedule timing at the platform layer:

- The platform uses PostgreSQL as the single source of truth, triggering only the designated active production target.
- Even if the target agent is dormant, the platform prewarms and wakes the instance seconds ahead of time, ensuring precise on-time execution.

---

## Accepted Engineering Trade-offs

- **Bounded cold-start latency**: First requests experience a bounded delay (gateway defaults to 30s timeout). Inbound requests experience backpressure rather than unbounded buffering.
- **At-least-once delivery semantics**: The platform guarantees exactly one durable ScheduleRun per due tick with idempotent dispatch claiming. If an ambiguous network timeout occurs, it transitions to `dispatch_unknown` for audited triage rather than blind automated replay.
- **Socket ownership verification**: Before marking deployments ready, the platform strictly confirms the listening socket belongs to the started unit, preventing traffic misrouting.

## Deeper reference

- [Why systemd, not Docker](/docs/reference/design/runtime): runtime density and dormancy economics
- [Routing and deployment lifecycle](/docs/reference/routing): activation leases and cold-start flows
- [Schedules and automation](/docs/observe/schedules): developer guide to scheduled execution
- [Scheduling behavior contract](/docs/reference/scheduling): planner state machine, prewarming, and execution boundaries
