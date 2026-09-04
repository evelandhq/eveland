---
title: Scheduling execution contract
description: Specification for schedule discovery, compiled artifacts, the planner, ScheduleRun state machine, and workflow retention classes.
---

This document defines the execution contract for Eveland as the sole production scheduler for agent workflows.

---

## 1. Schedule discovery and compiled artifacts

- **Cron syntax**: Strictly adheres to 5-field, UTC, minute-resolution cron specifications (e.g. `0 8 * * *`).
- **Discovery**: Automatically scans `agent/schedules/` during project import, alongside Extension Schedules declared in dependencies.
- **Immutable compilation**: Emits a validated `.eveland/scheduler/definitions.json` artifact bundled inside the immutable release, assigned an immutable `ScheduleVersion`.

---

## 2. Planner and ScheduleRun state machine

The Worker utilizes PostgreSQL as its source of truth to drive the execution pipeline:

$$\text{queued} \longrightarrow \text{activating} \longrightarrow \text{dispatching} \longrightarrow \text{running} \longrightarrow \text{completed / failed}$$

- **Missed tick coalescing**: If host maintenance spans multiple scheduled ticks, the Worker coalesces them into a single execution, records the count under `missedTicks`, and advances the next trigger timestamp into the future to prevent thundering-herd spikes.
- **Automated prewarming**: Seconds before a task tick arrives, the Planner acquires a temporary prewarm lease to wake dormant instances on demand.
- **Runtime protection**: Active ScheduleRuns prevent the idle reaper from terminating the pinned deployment while tasks are running.

---

## 3. Authenticated Scheduler Channel dispatch

- **Neutralizing local cron**: Release compilation replaces in-process Eve cron handlers with no-op shims, avoiding duplicate multi-target executions.
- **Channel invocation**: When due, the Worker calls the agent private Scheduler Channel using an ephemeral, single-use credential.
- **Atomic redemption**: The channel redeems the credential with the API before executing user handlers, guaranteeing that duplicate dispatch requests never trigger double execution.
- **Settlement boundaries**: Dispatches settle only after the platform projects a terminal turn boundary (e.g. `turn.completed` or `turn.failed`) from OTLP signals, at which point the execution lease is released.

---

## 4. Workflow retention context

Runs triggered by the scheduler execute under the **`scheduled`** retention class:

- Workflows become compactable 1 minute after completion;
- Successful runs are retained for 24 hours; failed executions persist for 7 days to facilitate operational audits.

## Deeper reference

- [Schedules and automation](/docs/observe/schedules): operator guide to schedule management
- [Workflow dispatch design decisions](/docs/reference/design/workflow): architecture behind external dispatching
- [Runtime and resources](/docs/operations/runtime): tenant partitioning and retention classes
