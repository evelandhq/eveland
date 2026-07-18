---
title: Schedules
description: Run Eve schedules once through Eveland with pinned releases, prewarming, and durable outcomes.
---

Eveland owns production schedule execution. Prepared Releases neutralize Eve's native cron handlers and expose authored definitions through a private authenticated Scheduler Channel, so previews and older Releases do not each execute the same business schedule.

## Definitions and versions

Eveland accepts strict five-field, minute-resolution UTC cron for supported Markdown and TypeScript schedules. Every imported definition becomes a versioned platform record.

## Pinned execution

When Worker creates a ScheduleRun, it pins the selected Deployment, Release, and ScheduleVersion. Promotion changes future runs only; an existing run never jumps to another target midway.

## Prewarm and activation

Worker keeps an upcoming target warm or wakes it during the configured prewarm window without executing the handler early. A due run acquires runtime protection so idle reaping cannot stop its pinned target.

Missed ticks coalesce into one run with an explicit count. Inspect ScheduleRun state and Worker diagnostics before retrying a result whose dispatch outcome is unknown.
