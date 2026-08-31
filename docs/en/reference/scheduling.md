---
title: Schedule execution
description: Behavioral reference for schedule discovery and the build artifact, the planner and ScheduleRun lifecycle, private Scheduler Channel dispatch, and settlement boundaries.
---

Eveland is the sole scheduler for production schedules. This page is the scheduling plane's behavioral contract: how definitions are discovered and built into an artifact, how the planner creates and settles ScheduleRuns, dispatch and credential-redemption semantics, and the Schedules page display rules. Why the platform owns the cron clock is explained in [Scale to zero](/docs/reference/design/scale-to-zero); the user-facing guarantees in [Schedules](/docs/observe/schedules); troubleshooting evidence in [Troubleshooting](/docs/reference/troubleshooting).

## Schedule discovery and the build artifact

The release adapter follows the global sliding Eve version window (see [Eve compatibility](/docs/reference/eve-compatibility)); any Eve dependency that could resolve outside the window must fail closed at build time with a clear adapter diagnostic — never guessed at or degraded.

On source import, root schedule keys are identified by their full relative path under `agent/schedules/`; after dependency installation, resolved Extension Schedules are additionally read from the Eve discovery manifest and join the same scheduling plane under Eve's `<mount namespace>__<schedule name>` rule. A same-named consumer override in a directory mount takes precedence over the Extension distribution. Both sources accept only five-field, UTC, minute-granularity cron semantics; a namespaced key conflict must fail the build before any module is rewritten — never silently keeping the native cron.

The final `.eveland/scheduler/definitions.json` is a required build artifact validated by key, cron, release-relative path, and definition hash; neither Docker nor systemd may fall back to the pre-install root-only definitions. Every Source Revision keeps an immutable ScheduleVersion. Each project additionally has an explicit scheduler target; future cron/manual runs pin to that deployment, release, and ScheduleVersion, and never re-select a traffic target through the Agent Gateway or the stable route.

## The planner and the ScheduleRun lifecycle

The worker treats Postgres as authoritative state and uses a bounded, multi-worker-safe planner to atomically create ScheduleRuns, enqueue `trigger_schedule` jobs, advance `nextRunAt`, and record coalesced missed ticks. If a worker outage spans multiple minute ticks, only one run is created for the earliest due time, the remaining missed ticks are counted into `missedTicks`, and `nextRunAt` advances to the first future instant — no burst replay.

The worker uses the persisted `nextRunAt` for schedule-aware scale-to-zero: once the scheduler target enters the prewarm window, a ready RuntimeInstance must not be marked `draining` by the idle reaper; if it has already stopped, the planner acquires a short prewarm ActivationLease and enqueues an idempotent activation job. Prewarming only starts the pinned release — it never pre-creates or pre-executes a ScheduleRun. Queued, activating, dispatching, or running ScheduleRuns give their pinned deployment hard reclamation protection.

Manual runs reuse the same job path. Before executing, the worker acquires a `schedule_run` ActivationLease, idempotently wakes the prebuilt release per the deployment's recorded `runtimeKind`, then calls the private Scheduler Channel inside the release with a short-lived single-use credential. Before executing the authored handler, the channel atomically redeems the credential with the API, and persists zero or more Eve session IDs before returning; duplicate jobs or credentials must not re-execute authored side effects.

A successful dispatch returning zero sessions completes immediately; a dispatch returning session IDs only means the authored handler has started — the ScheduleRun must stay `running` and its ActivationLease must keep protecting the RuntimeInstance. The boundary of the schedule execution is, for each returned session, the root `turn.completed`, `turn.failed`, `turn.cancelled`, or `session.waiting` that Built-in projects from Eveland's private OTLP LogRecords; the ScheduleRun settles and the lease releases only after every returned session reaches its boundary. `session.waiting` lets a durable conversation keep waiting for further input, but must not keep the process resident indefinitely.

Private OTLP observations must carry the RuntimeInstance generation that started them, and that provenance is stored on SessionNodes and SessionEvents. When the worker finds that generation stopped or lost, it must mark still-running associated Sessions/ScheduleRuns failed and record a platform event — never leaving them showing `running` forever. If the terminal turn boundary is permanently missing, the worker must additionally fail closed at the hard deadline `EVELAND_SCHEDULE_RUN_MAX_RUNTIME_MS` (default 24 hours). That deadline is a failsafe, independent of the default 5-minute activation idle TTL.

If the previous RuntimeInstance is `draining`, activation backs off within the health-check budget before credential redemption and creates the next generation once it stops; this is a transient wait, and the ScheduleRun must not be marked failed for it. Once a credential is redeemed, authored side effects must still never be replayed automatically because a response was lost.

A dispatch failure whose session creation may already have committed durable work — Eve's command-hook readiness timeout surfacing as `HookNotFoundError` — must be reported and recorded as `dispatch_unknown`, never `failed`: the scheduled Session can still start and execute the input later. Definite handler failures keep reporting `failed`. `dispatch_unknown` is terminally ambiguous — the run keeps the reported error, and a schedule must not be re-run manually on the assumption that nothing executed while its outcome is unknown.

## Prepared releases and the Extension integrator

A prepared release preserves the Eve registration shape of root and Extension Schedules but replaces native cron handlers with no-ops, so warm previews, older versions, and the stable target never each execute the same cron. When the source declares an Extension mount, the Extension package resolves only after dependency install, so the build runs `eve info` once first; then the self-contained platform integrator inside the release rewrites only the disposable release tree (modules replaced atomically, never modifying the pnpm content-addressed store), and only then run the real `eve build` and the final `eve info`. Releases without an Extension mount get neither the ~11 MiB integrator nor the extra pre-discovery step. The real Markdown/TypeScript handlers are invoked only through the authenticated private Scheduler Channel.

## The workflow retention context

The private Scheduler Channel is also the platform policy boundary for workflow retention. A Markdown Schedule's `from(...).send(...)` and every `to(...).send(...)` a handler Schedule exposes must execute inside the platform-owned `scheduled` run context; that context wraps outside authored options, so an authored spread cannot turn a schedule into `persistent`. If a delivery creates a new session, its root `workflowEntry` is `scheduled`; if it lands on an existing session, that session's stored root class wins and is never upgraded or downgraded by this delivery.

## Switching the scheduler target

Switching the scheduler target affects only cron/manual runs created after the switch. Already queued, running, or completed ScheduleRuns keep the deployment, release, and ScheduleVersion pinned at creation forever; promote, rollback, or stable-route weight changes never re-select their target.

## The Schedules page (/projects/:projectId/schedules)

Each schedule shows: name; the human-readable UTC period plus the original cron expression as the precise source of truth; timezone; enabled state; next trigger time; and the source file location.

The manual "Run now" action knows the schedule's latest run status. When that status is `dispatch_unknown`, queueing another run requires explicit confirmation: the earlier scheduled input may still execute, so a plain click must not silently risk a duplicate run.

Every cron or manual execution persists an independent ScheduleRun; success with no created session is a legitimate result. A ScheduleRun keeps release/deployment provenance, status, attempts, missed ticks, errors, and associated sessions, read by the Schedules history and Session-detail provenance. The worker also records, in the runtime logs by ScheduleRun ID, the pinned release/deployment/runtime, activation, Scheduler Channel dispatch, and final result phases, along with end-to-end duration. A dispatch timeout must write the actual timeout budget and the target deployment into the ScheduleRun error and logs — not just the underlying `AbortError` text; logs must never contain dispatch credentials, runtime secrets, or project secrets.

Below the schedule definition table, the latest 50 ScheduleRuns are shown with further pagination. The list covers all schedules by default; clicking a schedule's "view history" stays on the Schedules page, filters to that schedule (`schedule_id = current schedule`), and scrolls to Recent runs.

When a ScheduleRun is associated with exactly one session, its primary link goes straight to that session's detail. A zero-session run has no session to jump to, and a multi-session run cannot arbitrarily pick one, so both cases open the ScheduleRun detail to see the full execution result and associated sessions.

## Deeper reference

- [Schedules and automation](/docs/observe/schedules): developer guide to schedule definitions and execution
- [Workflow architecture design decisions](/docs/reference/design/workflow): external dispatching and purpose-built Workflow World rationale
- [Scale-to-zero design decisions](/docs/reference/design/scale-to-zero): why the platform owns cron clocks and target prewarming
- [Troubleshooting](/docs/reference/troubleshooting#schedule-did-not-run): diagnosing missed schedule runs and execution errors
