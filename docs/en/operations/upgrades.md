---
title: Upgrade and rollback
description: Upgrade an exact Eveland release while keeping migrations, component identity, and runtime ownership explicit.
---

Treat an Eveland upgrade as a coordinated product change, not an independent restart of five deployable components (Dashboard, API, Agent Gateway, Worker, and the Workflow Dispatcher).

Release-specific steps and compatibility notes live in the [GitHub Release notes](https://github.com/evelandhq/eveland/releases). Read the notes for every release between your current version and the target before you begin.

## Versioning and release channels

Eveland uses SemVer starting at `0.1.0`: fixes increment patch, features increment minor, and breaking changes before 1.0 also increment minor and carry explicit upgrade and rollback notes. Eveland supports the latest stable `0.x` release only; there are no long-term release branches or backports to older minors.

Every component reports one product identity — `version`, `revision`, `channel`, and `component` — in public `/health` (API, Agent Gateway), startup logs, and **Settings → About**. `channel` is `dev`, `edge`, `prerelease`, or `stable`: stable installations run an exact `vX.Y.Z` tag with `EVELAND_RELEASE_CHANNEL=stable`; an installation testing `main` uses `edge` and its exact revision. Missing values deliberately become `unknown` and `dev` rather than claiming a stable release. Set `EVELAND_REVISION` (normally `git rev-parse --short=12 HEAD`) and the channel identically for every component.

A GitHub Release currently identifies a reproducible source version, not an immutable set of container images plus a Worker package: operators check out the tag, install the frozen lockfile, apply migrations, and restart every component from the same revision. Do not treat a mutable branch, `latest` alias, or partially restarted checkout as release evidence.

## Before upgrading

1. Read the target GitHub Release notes and compatibility changes.
2. Back up Postgres, the shared workflow database, and the configured data root — see [Backup and restore](/docs/operations/backup-restore).
3. Confirm every component reports the current exact revision.
4. Check for runtime migrations or instructions that require draining deployments.

## Apply the release

From the core-services checkout, fetch tags, check out the selected stable tag, install the frozen lockfile, and apply versioned control-plane migrations:

```bash
git fetch --tags origin
git checkout vX.Y.Z
pnpm install --frozen-lockfile
pnpm --filter @evelandhq/api db:migrate
```

Apply the same tag and frozen install to the host Worker's own checkout (normally `/opt/eveland`). That is the whole Worker upgrade: the sandbox backend (`@evelandhq/sandbox-bwrap`) ships prebuilt from npm pinned by the lockfile, so there is no separate backend build step. Shared workflow-world schema migrations are not a manual step either — Worker startup and tenant provisioning apply every pending one automatically.

Set the same release channel and revision for all five components, then restart them from that checkout. Do not call the upgrade complete until public health, Worker startup identity, and **Settings → About** agree.

## Rollback boundary

Checking out an older tag is safe only when that release remains compatible with every migration already applied. Database migrations are not automatically reversed. Follow the release-specific rollback notes instead of assuming a source rollback is sufficient.

Never flip `EVELAND_RUNTIME` as an upgrade shortcut. Existing Deployments retain their recorded runtime owner and must be deliberately drained before a host runtime migration.

## Workflow runtime cutover (completed)

The one-time maintenance-downtime cutover to the shared, external-only workflow world shipped on 2026-08-18 and is complete. Fresh installs never run it: every new Release builds against the shared world, and a production Worker refuses to start without `EVELAND_WORKFLOW_WORLD_URL`, so an install first deployed on a current release is post-cutover by construction.

An install with pre-shared-world history is post-cutover when its cutover operation reached `completed`, the dispatcher registration reports ready with the matching World cluster identity, and no `EVELAND_PROCESS_MODE` or `EVELAND_WORKFLOW_CUTOVER_OPERATION_ID` remains configured anywhere.

Two kinds of legacy residue can outlive a completed cutover:

- **Deployments whose Release attests an `unknown` workflow world** (typically old local Docker Releases, whose images the classifier cannot inspect). They can never wake — workflow dispatch to them dead-letters — and their `unknown` topology keeps them unarchivable. Retire them explicitly:

  ```bash
  pnpm --filter @evelandhq/worker cutover -- retire --operation-id <id> \
    (--deployments dep_a,dep_b | --all-unknown)
  ```

  `retire` is fail-closed: it refuses any Deployment whose artifact actually classifies, or that owns an active run in the shared World. Accepted Deployments are fenced, converged, and moved to the `terminated` topology that archive accepts.

- **Legacy per-project workflow configuration.** Keep `WORKFLOW_POSTGRES_URL` (and `WORKFLOW_POSTGRES_BOOTSTRAP_URL`) configured only while legacy Deployments or Projects are still being terminated or deleted — deleting a legacy Project is what drops its derived `eveland_wf_<project>_<digest>` database. Once no retained Deployment attests a legacy world and `pg_database` lists no `eveland_wf_*` databases other than the shared World itself, unset both variables; the legacy stream-retention sweep (`EVELAND_WORKFLOW_SWEEP_*`) then has nothing to do. Orphaned `eveland_wf_*` databases can be dropped with standard Postgres tooling. External-only installs never set these variables.

The full executable runbook remains archived as a historical reference at [`.plans/workflow-external-cutover-runbook.md`](https://github.com/evelandhq/eveland/blob/main/.plans/workflow-external-cutover-runbook.md).
