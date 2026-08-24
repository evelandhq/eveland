---
title: Source import
description: Behavioral reference for the new-project wizard, source preflight, Git credentials, naming and slugs, import job execution semantics, and the Source page projection.
---

This page is the behavioral contract for the path source code takes into the platform: the new-project wizard, the source preflight, private-repository credentials, naming rules, the import job's execution semantics, and the Source page's structure-summary projection. The team-member narrative lives in [First deployment](/docs/agents/first-deployment); the Eve version-window gate in [Eve compatibility](/docs/reference/eve-compatibility).

## The new-project wizard (/new)

Creating a project uses a full-screen stepped flow without the workspace sidebar; the top keeps a way back to Projects. The old `/projects/new` exists only for compatibility and redirects to `/new`. Two import methods are supported: a Git repo URL and a zip upload.

Step one takes the repo URL or the zip. The API creates a user-isolated, expiring source preflight — no project is created yet. Git is shallow-cloned by the worker; a zip uses the same safely-extracted snapshot; the worker then reads the real file tree, checking the Eve project structure and the Eve version in `package.json`. Only a successful preflight advances the dashboard to the naming screen; failure stays on the source screen with an actionable reason.

The dashboard guesses the project name from the URL's last path segment with `.git` stripped — `evelandhq/sample-office-assistant` yields `sample-office-assistant`; a zip is guessed from its filename by the same rule. Step two shows the source summary and lets the user edit the name. Name format and availability are validated on the current screen; `Deploy` is clickable only when the name is valid and available.

The naming screen also offers an optional Environment Variables section: a Type/Name/Value table of at most 50 unique runtime entries. Type distinguishes `variable` from `secret`; adding and editing happen in a dialog, and the table shows only the configured state for values. Names follow the uppercase-letters/digits/underscores format; secret values default to a password input with a temporary reveal toggle, variable values use a plain text input. Users can also paste `.env` content or upload a `.env` file for bulk import; parsing ignores blank lines and `#` comments, accepts an `export ` prefix, and strips matched surrounding quotes. Before writing, a preview must show Type, Name, and Value, explicitly mark additions and overrides, and list per-line format errors; imported entries default to `secret` and can be switched to `variable` per row in the preview. Both value kinds are stored encrypted and never returned to the browser after saving. Partially filled rows, format errors, or duplicate names must be fixed in the dialog before joining the table and deploying.

The API encrypts values with `APP_SECRET_KEY` and, in a single database transaction, creates the project, saves the initial secrets, enqueues the initial import job, and consumes the preflight — guaranteeing the worker sees the required LLM keys when it picks up the first import/deploy job. Any failing step rolls back the whole transaction, and neither responses nor logs may return plaintext values.

## Private-repository credentials (PAT)

Private GitLab instances (including self-hosted ones) accept a personal access token next to the HTTPS repo URL; granting only `read_repository` is recommended. The platform does not probe intranet GitLab by domain guessing or extra requests. The API encrypts the PAT with `APP_SECRET_KEY` into the source preflight; the worker supplies temporary HTTP authentication to `git clone` scoped to the matching normalized host only, and never splices the PAT into URLs, the source `.git/config`, logs, or errors. Only after the clone, the Eve structure scan, and the subsequent Source Revision record all succeed is the PAT ciphertext saved per current user and host; failed preflights and imports save nothing. Later imports or syncs by the same user from the same host reuse the saved credential automatically, and an explicitly submitted new PAT replaces the old value only after that import succeeds. SSH/SCP URLs accept no PAT, and credentials embedded in URLs are rejected.

## Names, slugs, and internal IDs

The project name confirmed at creation claims the immutable slug in the public agent address: instance-unique, at most 53 characters, lowercase letters, digits, and `-` only, with no leading or trailing `-`. The dashboard gives instant feedback through a read-only availability endpoint; the creation endpoint must still claim exactly the user-confirmed name inside the database uniqueness boundary. A concurrent conflict returns `409` and stays on the naming screen — silently renaming to `name-1`, `name-2` is not allowed.

After creation the project also has a mutable display name (at most 80 characters) and an optional plain-text description (at most 240 characters). The display name is used in dashboard titles and lists; the description states, in brief capability language, the routines the agent can perform, for members' understanding and future Catalog discovery. Changing either must not change the slug, public agent endpoint, project ID, routes, or existing session/deployment relations. `proj_xxxxxxxxxx` remains the internal ID used by the platform, database relations, and `/projects/:projectId`; a readable public slug does not replace the internal primary key.

## Post-import processing

After import the platform: pulls or extracts the source; checks it is a valid Eve project; checks the Eve dependency in `package.json` is fully confined to the platform's current support window; identifies project config, agents, tools, skills, schedules, and the standard Eve Channel's `capabilities.eveChat`; and creates the Source Revision.

`agent/skills/` is discovered, compiled, and lazily loaded natively by Eve. Eveland does not map the runtime's `$HOME/.agents/skills` back onto the mutable source tree and does not interpret `defineSkill` itself; in a Release, `eve build` first generates independent workspace resources for each root/directory-form subagent, and the platform-injected sandbox backend then materializes the Eve-provided skill seed into that session's `$HOME/.agents/skills/<skill>/`. Markdown, module-backed, and packaged skills with `SKILL.md`, `references/`, `assets/`, and `scripts/` are all preserved; skill scripts run only through the agent's existing tools inside the same sandbox permission boundary and gain no extra host privileges or secrets.

Release builds must honor the imported project's committed package-manager lockfile: with `pnpm-lock.yaml`, a frozen install with the platform-pinned pnpm version; with `package-lock.json`, `npm ci`; only without a lockfile does it fall back to `npm install`. The pnpm frozen install still validates the lockfile and package integrity, but must not reject versions the project already locked because of the platform's own package minimum-release-age policy. Docker and systemd runtimes must make the same choice — never re-resolving a pnpm project with npm and bypassing its lockfile. Eve's `eve add` / `eve registry` belong to the source author's deliberate CLI usage only; Eveland's import, build, and deploy must not run these commands, reach the registry, or modify the immutable Source Revision.

## Git fetch and import-job execution semantics

Git fetches run non-interactively on the worker with a default cap of 120 seconds, adjustable via `EVELAND_GIT_CLONE_TIMEOUT_MS`. On timeout or Git failure the fetch must be terminated, the incomplete job source directory cleaned up, the job and project marked failed, and a length-capped, credential-masked error saved. Transient failures — DNS, connection, TLS, timeouts, HTTP 5xx — retry at most three times with exponential backoff by default; deterministic failures such as authentication errors or missing repositories do not retry.

The worker must keep renewing the lease for running jobs and reclaim jobs past the stale window without heartbeats; complete/fail must use the claim attempt as a fencing token so a late old worker cannot overwrite a newer attempt's state. At most one running job per project at a time: queued jobs must wait until that project's running job completes, fails, or is reclaimed before being claimed, and different projects never block each other. When a heartbeat is fenced off (the lease has been taken over by a newer attempt), the old execution must abort its own host side effects — canceling an in-flight build and stopping at the start/record/promote boundaries — rather than running to completion in parallel with the new one.

The project page shows the latest Git import job's queued/running/failed state, auto-refreshing while active, showing the reason and offering retry after failure; a create or sync endpoint returning "enqueued" must not be presented as the source having been fetched successfully.

## Preflight consumption and expiry

Once the user confirms the guessed project name and clicks `Deploy`, the project and the initial import job consume the completed preflight in one database transaction; a naming conflict must not consume the snapshot, and a consumed one must not be consumed again. The same `sourcePath` is recorded directly as the Source Revision — no second clone or re-upload. Unconsumed queued/completed/failed preflights expire after one hour by default and are cleaned by the worker strictly inside `EVELAND_DATA_DIR` containment; running preflights must not be expired away, and consumed records may be deleted at expiry while their project source remains governed by the project lifecycle.

The source import job rescans the same snapshot to establish the immutable Source Revision and enqueues `build_deploy` on success; a failed import must not proceed to deployment. The page polls the project, the import/deploy jobs, and the persisted logs, auto-following the newest log; a link to the project detail page is always available while deployment is in progress. When deployment completes, the copyable stable agent endpoint and the project detail link are shown. Leaving the page does not cancel background jobs.

## Source Revision metadata and restarts

The Source Revision must persist the `package.json` and recognized-lockfile metadata needed to start an existing Release. When the source directory has been reclaimed, cold activation and ScheduleRun activation still recover the package-manager/lockfile choice from this immutable metadata and start the original deployment without requiring a rebuild. Restart stays live-source-only: it must confirm the source directory still exists before stopping the current process; if missing, it fails and requires re-import/deploy — never interrupting the running process first, even when the database still holds the persisted metadata.

## The Source page (/projects/:projectId/source)

A read-only code browser supporting the file tree, file contents, the current Source Revision info, and the Eve project-structure summary. The summary covers at least agents, instructions, tools, skills, subagents, connections, schedules, and sandbox. No online editing, no Git write-back.

The Source page presents Connections only as part of the project-structure summary alongside other Eve entities — no separate Connections navigation or configuration UI. The built summary of a Release comes from the final `eve info` on the same installed dependency tree; the platform accepts only the discovery manifest version produced by the current window, and unknown versions continue to fail closed while keeping the static summary. The summary projects effective Extension Schedules and directly contributed Extension Subagents onto stable `agent/extensions/<namespace>/...` paths, with Subagent IDs using Eve's `<namespace>__<id>`; consumer overrides keep the same precedence as the Eve compiler. Only the root agent's Connection paths are projected; subagent-owned Connections stay within their own manifest scope.

## Deeper reference

- [Deploy your first agent](/docs/agents/first-deployment): developer quickstart for project import and builds
- [Eve compatibility window](/docs/reference/eve-compatibility): supported Eve version lines and dependency constraints
- [Agent environment](/docs/reference/agent-environment): secret/variable precedence and injection rules in the wizard
- [Dashboard contract](/docs/reference/dashboard): new project wizard, Projects list, and Git credentials management
