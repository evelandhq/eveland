---
title: Source import rules and preflight contract
description: Specification for the new-project wizard, source preflight checks, Git credentials (PAT), naming, and import job execution.
---

This page defines the end-to-end behavioral contract for importing source code into Eveland: covering the creation wizard, preflight verification, private repository credentials, naming rules, and asynchronous import job execution.

---

## 1. Project creation wizard (/new)

Projects can be imported via two sources: **Git Repository URLs** or **Zip Archives**.

- **Phase 1: Source input and Preflight verification**
  - The caller provides a Git URL or uploads an archive. The API generates an ephemeral, expiring `Source Preflight` token (default: 1 hour).
  - The Worker performs a shallow clone or safe extraction, inspecting project layout and verifying that the Eve dependency declared in `package.json` can resolve inside the supported version window (the build later checks the version it actually installed).
  - **One agent per repository, in `agent/`**: the agent's files live in `agent/` at the repository root (`agent/instructions.md`, `agent/agent.ts`, `agent/tools/`, ...). Preflight refuses eve's other layouts with an error that names them: agent files directly in the repository root (the flat layout), and eve workspaces with agents under `agents/<name>/`.
  - Advancing to the next step requires a passing preflight. Failures remain on the source step with actionable diagnostic reasons.
- **Phase 2: Project naming and environment configuration**
  - **Name inference**: Derived from the final segment of the Git URL (stripping `.git`) or archive filename, editable by the user.
  - **Environment secrets**: Supports manual entry or bulk `.env` paste. Distinguishes non-sensitive `variable` entries from encrypted `secret` credentials.
- **Phase 3: Atomic commit**
  - Clicking `Deploy` executes an atomic database transaction: creating the Project record, saving encrypted credentials, recording the initial Source Revision, and enqueuing the import job.
- **Phase 4: Import and first deploy**
  - The import job rescans the same snapshot to establish the immutable Source Revision and, on success, enqueues `build_deploy`; a failed import never proceeds to deployment.
  - The page polls the Project, the import and deploy jobs, and their persisted logs, following the newest log line, and always offers a link to the Project while the deploy runs. When the deploy completes it shows the copyable stable Agent endpoint and the Project link. Leaving the page does not cancel the background jobs.

---

## 2. Private repository credentials (PAT)

- **Least-privilege access**: For private GitLab or GitHub instances, personal access tokens (PAT) can be supplied, requiring only `read_repository` scope.
- **Secure in-memory authentication**: PATs are encrypted at rest with `APP_SECRET_KEY`. During `git clone`, credentials are passed ephemerally via HTTP headers in memory, never written to disk, URLs, or `.git/config`.
- **Automatic credential reuse**: Subsequent imports or syncs from the same host by the same user reuse stored credentials automatically.

---

## 3. Naming and Slug conventions

- **Public Slug**: Derived from the confirmed project name, serving as the subdomain for public agent routing:
  - Instance-unique, maximum 53 characters;
  - Lowercase alphanumeric characters and hyphens `-` only (no leading or trailing hyphens);
  - Conflicts reject with `409 Conflict` rather than appending synthetic random suffixes.
- **Display metadata**:
  - **Display Name**: Up to 80 characters, displayed in the console header and lists.
  - **Description**: Up to 240 characters, summarizing agent capabilities for team discovery and catalog projections.
  - Mutating display metadata does not alter the immutable public slug or route bindings.

---

## 4. Post-import dependency resolution

Builds honor committed package manager lockfiles strictly:

- **Lockfile precedence**:
  - Uses `pnpm-lock.yaml` with the platform-pinned pnpm version for frozen installs;
  - Uses `package-lock.json` with `npm ci`;
  - Falls back to `npm install` only when no lockfile exists.
- **Skills**: Eve discovers and compiles `agent/skills/` itself; Eveland does not interpret `defineSkill`, and skill scripts gain no host privileges or secrets through the platform. They run in the Agent sandbox like any other command.

---

## 5. Asynchronous import job execution

- **Timeouts**: Git fetch operations time out after 120 seconds by default (configurable via `EVELAND_GIT_CLONE_TIMEOUT_MS`). Timeouts trigger cleanup of incomplete working trees.
- **Single active job per project**: A Project permits **at most one running job at any time**. Queued tasks wait for active jobs to finish or time out.
- **Fencing token leases**: Workers continuously renew execution leases. If a stale lease is reclaimed by a new worker, previous execution attempts detect fencing and abort immediately to prevent dual-execution race conditions.

## 6. Source provenance and uploads to git projects

Every Source Revision records where it came from, not just what it contains:

- **Kind and commit**: `git` revisions are the commit they were synced at; `zip` revisions are an uploaded snapshot.
- **Origin**: `git-sync` (the platform cloned it), `cli-upload` (`eveland deploy`, authenticated with a CLI token), or `dashboard-upload` (the web console). Revisions recorded before this field existed report no origin.
- **Uploader, base commit, dirty flag**: an upload records who sent it and, when the CLI ran inside a git checkout, the commit the working tree was based on and whether it carried uncommitted changes. The upload rejects a base commit that is not a full lowercase hash, and a dirty flag without a base commit.

A Project's import kind is immutable and only says how the Project was created. Both kinds accept a multipart upload on `POST /api/projects/:id/sync-source`; the JSON body of the same route still re-clones a git Project from its stored repository URL, which an upload never changes. An upload onto a git Project may deploy (`deploy=true`) and, on request, promote (`promote=true`): that puts the Project in [hotfix drift](/docs/agents/releases-routing), reported as `hotfixDrift` on `GET /api/projects/:id` and on the deployments overview. While in drift, a JSON sync with `promote: true` — and a `build-deploy` with `promote: true` whose current revision was synced from git — is refused with `400` and `code: "hotfix_drift"` unless the body also carries `replaceHotfix: true`; the message names the hotfix's uploader, time and base commit.

`GET /api/projects/:id/deployments` returns `releaseSources`, keyed by Release id, with the provenance of each listed Deployment's source; the Deployments page renders it as "Commit abc123" or "Uploaded from the CLI by _user_, based on abc123, with uncommitted changes".

## 7. Source Revision metadata and restarts

A Source Revision persists the `package.json` and recognized lockfile metadata needed to start an existing Release. After the source directory is reclaimed, cold activation and ScheduleRun activation still restore the package manager and lockfile choice from that immutable metadata and start the original Deployment, without rebuilding the Release. Restart stays live-source-only: it confirms the source directory still exists before stopping the running process, and when it is missing the restart fails and asks for a re-import and deploy, without interrupting the running process, even though the metadata is still in the database.

## 8. Source page (/projects/:projectId/source)

A read-only code browser: the file tree, file contents, the current Source Revision, and a summary of the Eve project structure (at least agents, instructions, tools, skills, subagents, connections, schedules, and sandbox). There is no online editing and no Git write-back.

The browser fills the whole project content canvas, with no outer frame and no page-level padding. File search is the first control of the tree panel; its borderless toolbar lines up with an equally compact preview header that shows only the current path. The file tree and the header stay fixed, and the code body scrolls in both directions on its own, so the horizontal scrollbar is always at the bottom of the visible area. Code uses a 12px font, 18px line height, and muted line numbers; the frame shows no file type, file size, or Eve version metadata.

Connections appear only in the structure summary, alongside the other Eve entities; there is no separate Connections navigation or configuration UI. A Release's built summary comes from `eve info --json` (eve's documented output) run after `eve build` on the same installed dependency tree: compile status, layout, diagnostic counts, the root Agent's model, the instruction file, and the names of skills, tools, declared subagents, schedules, and channels (names an Extension contributes carry a `<namespace>__` prefix). `eve info` lists no hooks, connections, sandbox, or remote agents, so the built summary has none either. Output the platform does not recognize fails closed, and no built summary is recorded.

## Deeper reference

- [Deploy your first agent](/docs/agents/first-deployment): developer onboarding guide
- [Eve compatibility window](/docs/reference/eve-compatibility): supported framework versions
- [Security model](/docs/operations/security): PAT encryption and sandbox isolation
- [Agent environment](/docs/reference/agent-environment): Secret and Variable precedence and injection for wizard entries
- [Dashboard page contract](/docs/reference/dashboard): the Projects list and Git credential management
