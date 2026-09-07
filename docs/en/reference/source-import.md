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
  - The Worker performs a shallow clone or safe extraction, inspecting project layout and verifying that the Eve framework dependency declared in `package.json` falls within the supported compatibility window.
  - Advancing to the next step requires a passing preflight. Failures remain on the source step with actionable diagnostic reasons.
- **Phase 2: Project naming and environment configuration**
  - **Name inference**: Derived from the final segment of the Git URL (stripping `.git`) or archive filename, editable by the user.
  - **Environment secrets**: Supports manual entry or bulk `.env` paste. Distinguishes non-sensitive `variable` entries from encrypted `secret` credentials.
- **Phase 3: Atomic commit**
  - Clicking `Deploy` executes an atomic database transaction: creating the Project record, saving encrypted credentials, recording the initial Source Revision, and enqueuing the import job.

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
- **Skills discovery**: Directories under `agent/skills/` are discovered natively by Eve. Eveland compiles sandboxed resource definitions, ensuring skill scripts execute strictly within sandboxed boundaries.

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

A Project's import kind is immutable and only says how the Project was created. Both kinds accept a multipart upload on `POST /api/projects/:id/sync-source`; the JSON body of the same route still re-clones a git Project from its stored repository URL, which an upload never changes. An upload onto a git Project may deploy (`deploy=true`) but must not promote: `promote=true` is refused with `400`, because promoting it would put production on a revision the next sync replaces. Promote the resulting preview from the Deployments page if that is what you want.

`GET /api/projects/:id/deployments` returns `releaseSources`, keyed by Release id, with the provenance of each listed Deployment's source; the Deployments page renders it as "Commit abc123" or "Uploaded from the CLI by _user_, based on abc123, with uncommitted changes".

## Deeper reference

- [Deploy your first agent](/docs/agents/first-deployment): developer onboarding guide
- [Eve compatibility window](/docs/reference/eve-compatibility): supported framework versions
- [Security model](/docs/operations/security): PAT encryption and sandbox isolation
