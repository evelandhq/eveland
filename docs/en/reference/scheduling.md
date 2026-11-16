---
title: Scheduling execution contract
description: Specification for schedule discovery, compiled artifacts, the planner, ScheduleRun state machine, and workflow retention classes.
---

This document defines the execution contract for Eveland as the sole production scheduler for agent workflows.

---

## 1. Schedule discovery and compiled artifacts

- **Cron syntax**: Standard 5-field, minute-resolution cron (e.g. `0 8 * * *`).
- **Timezone**: A schedule may set eve's `timezone` to an IANA name, in `defineSchedule` or in Markdown frontmatter, and the platform reads its cron on that zone's wall clock: `cron: "0 13 * * *"` with `timezone: "America/Los_Angeles"` runs at 13:00 Pacific, 20:00 UTC in summer and 21:00 UTC in winter. A schedule without `timezone` runs in UTC on every host (eve itself would use the process timezone on a self-hosted server). The name is stored in canonical form (`"utc"` becomes `"UTC"`); an offset such as `"+08:00"` or an unknown name fails the build, and `timezone` must be a string literal so the platform can read it before the build. Across daylight saving changes the platform follows eve's self-hosted rule: a local time the clock skips runs at the next valid local time (`30 2 * * *` runs at 03:00 on the spring-forward day), and a local time the clock repeats runs once, at its first occurrence.
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

- **eve's own runner stays off**: Every Deployment runs with `EVE_SCHEDULES_DISABLED=1` (reserved, so a project entry cannot turn it back on), so no Deployment fires a schedule on eve's cadence and a project with several running Deployments never runs a schedule twice. Authored schedule files are left exactly as written; the injected Channel imports each module schedule and embeds each Markdown schedule's prompt. Release preparation only reads each module schedule's `cron`, `timezone`, and `content` or `run` from its source, which is why a schedule must use a concrete default export with those fields written as literals.
- **Channel invocation**: When due, the Worker calls the agent private Scheduler Channel using an ephemeral, single-use credential.
- **Atomic redemption**: The channel redeems the credential with the API before executing user handlers, guaranteeing that duplicate dispatch requests never trigger double execution.
- **Settlement boundaries**: Dispatches settle only after the platform projects a terminal turn boundary (e.g. `turn.completed` or `turn.failed`) from OTLP signals, at which point the execution lease is released.

### Differences from eve's own schedule runner

eve marks the sessions its own runner starts as scheduled, and eve 1.0 offers no public way for another dispatcher to do the same. The platform starts a schedule's sessions through the Scheduler Channel instead, so eve treats them as ordinary channel sessions:

- **Sign-ins**: eve fails a scheduled turn's calls that need a connection sign-in with `reason: "sign_in_unavailable"`. On Eveland the turn asks for the sign-in and waits for an answer nobody is there to give, until the session times out. Give scheduled work connections that need no per-user sign-in.
- **Approvals**: eve fails a Markdown schedule's session when a tool needs approval, because that session has no channel. On Eveland the session belongs to the Scheduler Channel, so eve does not refuse the approval up front, and nobody can grant it there.
- **Replies**: eve keeps only a scheduled turn's final reply. On Eveland, text the model writes before it waits on a task is delivered as its own message, which matters when a handler sends into a channel such as Slack.
- **Instrumentation**: eve's session context carries no `scheduleId` for these sessions. Eveland records the schedule, ScheduleRun, and trigger on the Session itself.

---

## 4. Workflow retention context

Runs triggered by the scheduler execute under the **`scheduled`** retention class:

- Workflows become compactable 1 minute after completion;
- Successful runs are retained for 24 hours; failed executions persist for 7 days to facilitate operational audits.

## Deeper reference

- [Schedules and automation](/docs/observe/schedules): operator guide to schedule management
- [Workflow dispatch design decisions](/docs/reference/design/workflow): architecture behind external dispatching
- [Runtime and resources](/docs/operations/runtime): tenant partitioning and retention classes
