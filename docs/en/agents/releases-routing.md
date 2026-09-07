---
title: Releases and traffic routing
description: Understand immutable previews, production routes, weighted traffic splitting, session affinity, and retention policies.
---

Eveland decouples authored source code, release artifacts, runtime deployments, and public routes, allowing you to deploy and test new versions without risking production availability:

```text
Project
  └─ Source Revision
       └─ Immutable Release
            └─ Deployment
                 ├─ Dedicated Preview Host (Immutable)
                 └─ Stable & Alias Routes (Mutable)
```

## 1. Immutable previews and atomic promotion

- **Immutable previews**: Each **Build & Deploy** triggers a brand-new immutable Release and starts a separate Preview Deployment with a unique, permanent preview URL.
- **Atomic promotion**: Once verified, clicking **Promote** atomically re-points the production route (Stable Route) to the new deployment at the gateway layer — **without needing to rebuild the codebase**.
- **Instant rollbacks**: If an issue arises post-release, you can immediately point the route back to any retained healthy historical deployment for instant recovery.
- **Source provenance**: Each Deployment shows where its Release's source came from: the synced commit, or the upload (from the CLI or the Dashboard, by whom, based on which commit, and whether the working tree was dirty). An upload onto a git Project arrives as a preview by default; promoting it — from this page, or with `eveland deploy --promote` — is a deliberate step that puts the Project in **hotfix drift** (section 5).

## 2. Canary releases and weighted routing

Routes can be configured with weighted splitting across two active deployments:

- **Dual-target splitting**: Allocate traffic between two deployments using basis points (summing to 10,000, representing 100%). For instance, `9000 : 1000` splits traffic 90% to 10%.
- **Deterministic session bucketing**: Newly initiated root conversations are assigned to a target via deterministic hashing, ensuring accurate statistical distribution.
- **Automatic failover**: If one of the targets in a weighted split is unhealthy or starting up, the gateway automatically directs unpinned incoming traffic to the surviving healthy target, avoiding client-facing errors.

## 3. Session affinity and graceful draining

For multi-turn conversations and interactive sessions, route changes must never break active user dialogues:

- **Durable SessionBinding**: Once an Agent generates a session ID, Eveland persists an explicit binding between that session and the handling Deployment.
- **Affinity persistence**: Follow-up turns (Continue), cancellations (Cancel), or streaming listeners (Stream) are **always forwarded to the originally bound Deployment**, even if that deployment was rolled back or had its traffic weight reduced to 0%.
- **Graceful draining**: Superseded deployments remain in a `draining` state, finishing in-flight conversations before cleanly shutting down.

## 4. Retention and automatic archiving

To balance audit history with host disk capacity, Eveland enforces automated lifecycle safeguards:

- **Protected releases**:
  - The latest N releases per project (based on retention policies);
  - Any deployment currently targeted by a production or alias route;
  - Any deployment maintaining unexpired session bindings (SessionBinding) or active request leases (ActivationLease).
- **Automated archiving**: Once an unprotected deployment stops, the background Worker purges its cached runtime artifacts and build directories to prevent disk accumulation.

## 5. Hotfix drift

A git Project can run an uploaded revision in production — a hotfix sent with `eveland deploy --promote` from a working tree, or a preview upload promoted from the Deployments page. Eveland allows this, but makes the resulting state visible and guards the way out of it.

- **Definition**: a Project is in hotfix drift while its promoted Deployment's Release comes from a Source Revision whose origin is an upload rather than `git-sync`. The state is derived from those rows on every read, never stored, and only a git Project can drift.
- **Visibility**: every project page shows a banner — "Production runs an uploaded hotfix (based on `abc123`, uncommitted changes, by _user_ at 14:02); the repository does not contain it. Commit it before the next production sync." — the Deployments list shows each Deployment's provenance, the deploy log records the promote that started the drift, and `eveland deploy --promote` prints the same warning after promoting. `GET /api/projects/:id` and `GET /api/projects/:id/deployments` return it as `hotfixDrift`.
- **Guarded sync**: while in drift, promoting a revision that came from git retires the hotfix, so **Sync, deploy & promote** (and **Build, deploy & promote** when the current revision was synced after the hotfix) shows the warning and requires an explicit confirmation; the JSON API refuses with `400` and `code: "hotfix_drift"` unless the body carries `replaceHotfix: true`. A preview sync replaces nothing and asks nothing. Rebuilding the hotfix itself, or uploading another hotfix with `eveland deploy --promote`, is the same kind of source replacing itself: no confirmation, but the CLI prints the provenance of what it replaces.
- **Clearing**: drift clears the moment a `git-sync` revision is promoted — a rollback included. Eveland deliberately does not compare tree contents: committing the hotfix to the repository and syncing it to production is the only way to end the drift with the same code.

## Related references

- [Routing and deployment lifecycle contract](/docs/reference/routing)
- [Agent Gateway design and security model](/docs/reference/design/gateway)
- [Scale-to-zero and cold activation](/docs/reference/design/scale-to-zero)
