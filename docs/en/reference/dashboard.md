---
title: Dashboard page contract
description: The display and interaction contract for every dashboard page — login, Projects, Settings, project pages, and Logs.
---

This page collects the display and interaction contract for every dashboard page. Domains whose behavior crosses platform boundaries have their own deep references: [Agent identity](/docs/reference/identity), [Source import](/docs/reference/source-import), [Playground](/docs/reference/playground), [Schedule execution](/docs/reference/scheduling), [Agent environment](/docs/reference/agent-environment), and [Observability](/docs/reference/observability).

## Login (/login)

The platform signs in with email and password. On first startup the platform idempotently creates a default admin:

- Default email `admin@example.com`, overridable via `EVELAND_ADMIN_EMAIL`
- Initial password: must come from `EVELAND_ADMIN_PASSWORD`, at least 12 characters
- Users, password accounts, and sessions use Better Auth; team members and invitations use the Organization plugin
- No built-in production default password; `BETTER_AUTH_SECRET` must be configured independently, at least 32 characters
- Login sessions use HttpOnly, SameSite=Lax cookies; implicit account-connection merging is disabled by default
- Visiting `/login` with a valid member session redirects straight to `/projects`

## Projects (/projects)

Shows all of the user's projects: project name; current deployment status; last updated time; current Eve version (shown in red with an upgrade hint when behind the latest supported version or unsupported); latest session status; next schedule time if any (in the personal display timezone, `HH:mm` 24-hour for today, `MM-DD HH:mm` otherwise). Supports creating, deleting, and entering projects.

Project deletion is permanent and asynchronous. The user must type the full project name to confirm; the API atomically marks the project `deleting` and creates a unique `delete_project` job. The Projects list keeps the project with a `Deleting…` badge until the job completes; the detail page stays readable with mutating actions disabled, and a deleting project rejects new deploy, sync, secret, Playground, and other mutation requests. On failure the project record is kept, showing `Delete failed` with the reason, and retry is allowed.

The deletion job must wait for the project's already-running jobs to finish, then stop all `running` or `draining` deployments. It then deletes releases per each deployment's recorded `runtimeKind`, cleans platform-managed source, build, agent observability policy, and durable sandbox workspaces, and finally cascade-deletes routes, SessionBindings, OperationBindings, sessions, usage, schedules, secrets, logs, and project data. The platform must never delete external source paths outside `EVELAND_DATA_DIR`. External resource cleanup cannot share a transaction with Postgres; on failure some processes or artifacts may already be stopped or removed, but the project record and its error state must survive to support idempotent retry.

## Navigation shells

The main workspace shell applies only to Projects, Deployments, and Usage. Its top-left shows the Eveland logo, and its bottom-left shows the current user's avatar, name, and email. The whole user row is a single account-dropdown trigger whose menu offers Settings and Sign out.

Project detail routes use a separate project shell. Its top-left returns to Projects, the remaining sidebar contains only that project's navigation, and it has no user footer. Settings routes likewise use a separate settings shell: its top-left returns to the workspace, its navigation is grouped into Personal and System, and it has no user footer.

## Profile (/settings/profile)

Personal settings support: changing the name; uploading, replacing, or removing the avatar (PNG, JPEG, WebP only, at most 512 KB); viewing the login email (currently read-only); configuring the display timezone (defaults to the browser's current IANA timezone until a preference is saved, then applies as a personal preference across pages and login sessions); and changing the password with the current password (new password at least 12 characters; success revokes every login session other than the current one).

Every absolute date and time in the dashboard — lists, details, Logs, session timelines, ScheduleRuns, Usage, and Instance Health chart axes and tooltips — renders in the current user's display timezone, never decided by the Next.js Server Component's runtime default timezone. A schedule's raw cron and its declared `UTC` timezone still render with source semantics; actual instants such as `nextRunAt` and due/start/complete times use the personal timezone.

Profile updates reuse the Better Auth user record. Better Auth's HTTP surface is exposed by allowlist: only `sign-in/email`, `sign-out`, and `get-session` are publicly routable, and every other endpoint (including `update-user`, `change-password`, sign-up, the organization and admin families, and anything future versions add) is a 404 — password changes must go through Eveland's `/profile/password` (forcing revocation of other sessions), and invitations and member management go through Eveland-owned endpoints.

## Git credentials (/settings/git-credentials)

Personal settings list the current user's saved Git HTTPS host credentials, showing only the normalized host, update time, and a delete action — never returning, copying, or hinting at the PAT value, its length, or its prefix/suffix. Credentials arrive by two paths: saved automatically after a successful private-repository import, or added manually on this page (enter host and PAT; hosts normalize to lowercase and may carry a port; paths, non-scheme prefixes, and embedded credentials are rejected; re-adding the same host replaces its PAT). Manual saves take effect immediately without requiring a prior import. Credentials are isolated per `(userId, host)` and cannot be reused by other members of the same team. Deletion affects only later imports/syncs and never modifies already-imported Source Revisions.

## Members (/settings/members)

Members lives in the Settings System group and no longer appears in the workspace global navigation. Roles: `admin` holds all project permissions and can invite, remove members, and change roles; `member` can manage projects, secrets, and deployments, but not members.

The page shows active members and pending invitations. Admins can: create seven-day, single-use invitation links by email; refresh an invitation to rotate its token and extend validity; copy or revoke invitation links; set members to Admin/Member; and remove members (removal immediately revokes all their login sessions; team projects are not deleted). The last admin can be neither removed nor demoted. Invitation links use 256-bit opaque random identifiers and expire immediately on acceptance.

## About (/settings/about)

About shows the current Eveland product version, Git revision, and release channel. The sidebar bottom keeps a compact version number; About also shows the component build identities reported by the Dashboard build and the API `/health`. When their version, revision, or channel differ, it must state clearly that the instance has not finished a consistent upgrade. The worker adds no public HTTP service for this; its build identity goes to the startup log.

About also shows admins a read-only runtime configuration diagnostic for the Dashboard, API, Agent Gateway, and Worker: supported environment variable names, owning component, effective value, value source, purpose, and missing/warning status. Members cannot read this diagnostic endpoint. The diagnostic uses an explicit allowlist and can never enumerate or echo the process's full `process.env`; secrets show only configured/not-configured — no viewing, copying, lengths, prefixes/suffixes, or anything else recoverable — and connection URLs must strip credentials, query values, and fragments. Defaults and derived values are computed by each component's actual runtime rules with their source labeled; unconfigured required values and unsafe development fallbacks must warn explicitly.

Agent Gateway configuration is readable only through the existing service-authenticated `/internal/*` boundary and must not join the public `/health`. The worker still adds no HTTP service: after a successful startup preflight it atomically writes an already-masked snapshot with private permissions into the shared `EVELAND_DATA_DIR/diagnostics`, which the API then reads; no secret value may enter that snapshot, the API response, or the dashboard payload. When a component is unreachable or its snapshot missing or invalid, About shows that component as unavailable and must not fall back to reading its raw environment files.

The Eveland product version and a project's Release/Deployment are two independent concepts: the former identifies the platform software itself; the latter remains an imported agent's immutable build artifact and run target.

## Instance Health (/settings/health)

Instance Health lives in the Settings System group, admin-only. It presents "is it currently available" separately from "is it approaching capacity risk", showing at least:

- Current status, evidence, and last-observed time for the API, Postgres, Agent Gateway, Worker, and Collector; Collector status derives from the arrival time of the latest OTLP batch (it is Built-in's only sender), and a stale batch cannot keep proving the Collector online
- The worker's continuous heartbeat; the startup configuration snapshot cannot substitute for liveness
- The worker host's CPU, load, available memory, and the capacity and inodes of the filesystem holding `EVELAND_DATA_DIR`
- Queued/running job counts, the oldest queued job, and the RuntimeInstance state distribution
- 24-hour and 7-day trends, with a projected days-to-disk-exhaustion once enough growth history exists

The Worker is the only privileged component collecting host metrics; it sends heartbeats and metric samples as standard OTLP metrics in the capacity domain, Built-in projects them into Postgres, the API only reads and aggregates, and the dashboard displays read-only. Sampling defaults to every 60 seconds with 30-day retention and daily cleanup of expired samples. The worker heartbeat publishes independently of long build/deploy jobs and must not be misjudged offline because a job is executing. A `stopped` RuntimeInstance is normal scale-to-zero and must not alone be treated as a failure; a delayed/degraded Collector shows the instance degraded but does not mean agent traffic is interrupted.

In-page risk hints must not claim to cover a full power loss: total server loss still requires external monitoring polling the public API and Agent Gateway `/health`. Instance Health offers no shell, systemd restarts, or any other host write operation.

## Project Overview (/projects/:projectId)

Overview defaults to the last seven days of execution — not full deployment management: session counts, running count, terminal-session completion rate and failures; total input/output tokens, usage coverage, and provider/AI-Gateway-reported cost; per-day session trends; recent sessions; current production status, Eve version, and stable agent endpoint; and the next enabled schedule.

Overview's primary action is Open Playground, with drill-downs to Sessions and Usage. Full build, preview, traffic, and rollback operations live in Project Deployments.

The project sidebar orders daily observation first: Overview, Playground, Sessions, Logs, Schedules, Usage, then below a divider Deployments, Source, Settings. Logs keeps its independent first-level entry — users never need to establish a diagnostic path through Overview, a session, or a deployment first.

## Deployments (/projects/:projectId/deployments)

Shows and manages: the current production deployment, release, Source Revision, and stable/preview endpoints; deployment history, deploy times, runtime kind, and retention protection; and the stable endpoint's current targets and traffic weights.

Primary operations:

- The page offers exactly one `Create deployment` entry point — no stack of top-level buttons per action combination
- The dialog's Source dimension defaults to the current immutable Source Revision; Git projects can explicitly choose to sync and validate the latest remote code first, zip projects only use the current Source Revision
- The dialog's outcome dimension defaults to atomically promoting the new deployment to stable target after it passes health checks; the user can explicitly keep it as a concurrently testable preview without changing the stable target
- Submit labels state the combination exactly — `Build & deploy`, `Build, deploy & promote`, `Sync & create preview`, or `Sync, deploy & promote` — never an ambiguous `latest` meaning both the current revision and remote Git
- Restart deployment
- Open Playground
- View logs

## Sessions (/projects/:projectId/sessions)

Sessions is the core run history. The list shows only actual Eve sessions and never mixes ScheduleRun execution envelopes in as peer rows; cron/manual-created sessions still sort with all other sessions by `startedAt` descending.

Each session shows: session ID; trigger source (Playground / Cron / Webhook / Channel / API); associated schedule (when cron-triggered); start time; status (Running / Completed / Failed / Waiting Approval); current deployment; input/output/total token consumption; and usage completeness (complete / partially missing / provider unreported).

A session created by a ScheduleRun shows, under the detail page title, a single-line compact provenance: schedule key, cron/manual trigger, ScheduleRun status, and start time. Cron runs also show the human-readable period in 24-hour, explicitly UTC-labeled form plus the original five-field expression; missed ticks and errors appear only when present. The full release/deployment and multi-session relations remain viewable through the ScheduleRun detail.

Inside a session, Eve's event timeline renders (message → model response → tool call → tool result → step complete → final response / failure). The detail page shows no span tree or LogRecord detail. Built-in stores no raw agent spans or LogRecords; span-level drill-down comes from an external destination receiving agent traces once enabled, and data user instrumentation sends to its own backend is never read or merged by Eveland.

Per actually executed Eve agent/subagent it also shows: model step counts; input tokens; output tokens; cache read/write tokens; and provider- or AI-Gateway-returned cost when present.

Filters: trigger, schedule, status, and time range.

## Usage (/usage and /projects/:projectId/usage)

Usage is the agent-traffic and model-consumption analysis page for developers and admins, not a replacement for `/settings/health`'s component, host, and capacity diagnostics. The workspace `/usage` aggregates all projects; project Usage is fixed to a single project; both reuse the same time ranges, metric definitions, trend charts, and model attribution. Only project Usage offers session drill-down; workspace `/usage` keeps the operational aggregate view without mixing in a concrete session list.

The page supports the last 24 hours, 7 days, and 30 days, showing the current period against the previous equal-length period. Statistics must aggregate server-side over the full time range — never presenting page one of a paginated session list as the total. It shows at least:

- Session counts, running sessions, terminal-session completion rate and failures
- Model step counts, plus input/output/cache-read/cache-write tokens
- Provider- or AI-Gateway-reported cost; missing cost must never be estimated from public price lists
- Usage coverage and cost coverage, computed and presented separately
- Time series for sessions, model steps, tokens, and cost
- Workspace project attribution, model attribution, and Eve agent × LLM model attribution
- Recent sessions with drill-down in project Usage

A model filter switches the main trend chart to a single-model view. Session counts then mean distinct root sessions actually using that model within the selected time bucket, and tokens, cost, and steps bucket by the model usage event's time. One root session can span multiple Eve agents/subagents and multiple models, so a whole session is never force-labeled with one model. Steps whose model cannot be resolved from the observed SessionNode stay `Unknown model` — never dropped or guessed.

## Project Settings (/projects/:projectId/settings)

Project Settings is one centered page containing project details, Variables and Secrets, and the danger zone. Project details edits the display name and description and shows the immutable project slug, project ID, and source repository read-only. Variables and Secrets manages the project's runtime configuration (see [Agent environment](/docs/reference/agent-environment)). The old `/projects/proj_xxxxxxxxxx/secrets` path redirects to `/projects/proj_xxxxxxxxxx/settings`.

## Logs (/projects/:projectId/logs)

Logs offers three log kinds: build logs; deploy logs; and runtime stdout/stderr plus ScheduleRun lifecycle diagnostics. An agent's concrete execution belongs in the session timeline, not in Logs.

The Logs page defaults to newest-first, offering text search, kind filtering, and sort-order toggling inside a fixed-height scroll area. Multi-line or overlong records default to a compact summary, expandable per row to the full original text.

## Deeper reference

- [Deploy your first agent](/docs/agents/first-deployment): quickstart for core console deployment actions
- [Sessions and usage](/docs/observe/sessions): data models behind the Sessions and Usage console pages
- [Health and diagnostics](/docs/operations/diagnostics): health metrics and log triage matrix in the console
- [Security model](/docs/operations/security): platform authentication, invitations, and team permissions
