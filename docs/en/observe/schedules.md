---
title: Schedules and automation
description: Master agent cron schedules, pinned execution targets, and automated prewarming.
---

In multi-version preview and canary deployment environments, traditional in-process cron jobs cause critical hazards — such as older releases and preview deployments concurrently firing duplicate business schedules.

Eveland **centralizes production schedule execution at the platform layer**: neutralizing in-process cron handlers and waking only the designated production deployment precisely on schedule.

---

## 1. Schedule definitions and versioning

- **Cron syntax**: Supports standard five-field UTC cron expressions at minute resolution (e.g. `0 9 * * 1-5` for weekdays at 09:00 UTC).
- **Configuration as code**: Schedules defined in Eve projects via Markdown or TypeScript are parsed during source import and stored as versioned platform records.

---

## 2. Pinned execution targets

To ensure execution stability when a schedule fires:

- **Durable ScheduleRun**: The Worker pins the execution to the exact Release, Deployment, and ScheduleVersion targeted by the active route at that moment.
- **Uninterrupted promotions**: Promoting a new release while a scheduled task is running does not switch the in-flight execution mid-turn; subsequent runs will target the newly promoted release.

---

## 3. Automated prewarming and activation

Thanks to scale-to-zero architecture, scheduled tasks execute reliably even if the target agent is dormant (`stopped`):

- **Prewarm window**: The Worker automatically wakes dormant agent instances seconds before the due timestamp, ensuring the process is fully ready when the tick arrives.
- **Runtime protection**: While executing, the instance acquires an activation lease preventing the idle reaper from stopping it mid-task.

---

## 4. Audit trail and failure triage

Scheduled executions are recorded as **ScheduleRun** entities under project sessions:

- Inspect execution timestamps, associated conversation IDs, turn durations, and aggregated token usage;
- If host downtime causes missed ticks, Eveland coalesces them into a single run with an explicit recovery count.

## Deeper reference

- [Scheduling behavior contract](/docs/reference/scheduling): cron syntax, prewarm timeouts, and the ScheduleRun state machine
- [Workflow dispatch design decisions](/docs/reference/design/workflow): external dispatchers and durable workflows
- [Troubleshooting schedules](/docs/reference/troubleshooting#schedule-not-running): diagnosing schedule dispatch issues
