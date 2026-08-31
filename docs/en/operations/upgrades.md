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

## Port block migration

Eveland moved every default listen port off the generic development ports and into a platform-owned block; the dynamic Deployment range left the Linux ephemeral port range. Container-internal ports (Compose service DNS such as `postgres:5432` and `otel-collector:4318`) are unchanged — only host-visible ports moved:

| Service                                      | Old default | New default |
| -------------------------------------------- | ----------- | ----------- |
| Dashboard                                    | 3000        | 17300       |
| API (`PORT`)                                 | 4000        | 17301       |
| Agent Gateway (`GATEWAY_PORT`)               | 4080        | 17302       |
| Postgres host mapping                        | 5432        | 17310       |
| Collector platform receiver                  | 4317/4318   | 17311/17312 |
| Collector Agent receiver                     | 4327/4328   | 17313/17314 |
| Docs dev server                              | 3001        | 17350       |
| Deployment range (`EVELAND_DEPLOYMENT_PORT`) | 41000       | 18000       |

For an existing installation:

1. Update every URL and port in your `.env` and systemd env files that referenced an old default (`DATABASE_URL`, `EVELAND_WORKFLOW_WORLD_URL`, `BETTER_AUTH_URL`, `EVELAND_GATEWAY_INTERNAL_URL`, `EVELAND_API_INTERNAL_URL`, `EVELAND_OTLP_ENDPOINT`, `EVELAND_IDENTITY_JWKS_URL`, `EVELAND_SCHEDULER_REDEEM_URL`, `WEB_ORIGIN`, `NEXT_PUBLIC_API_URL`, `API_URL`, ...) — compare against the current `.env.example`. Keeping the old ports in your env files is also supported; the defaults moved, explicit configuration always wins.
2. Update your reverse proxy upstream (Agent Gateway `4080` → `17302`) and host firewall rules (block `17310` instead of `5432` from non-local networks).
3. `NEXT_PUBLIC_API_URL` is baked into the Dashboard at build time: rebuild the web app after changing it.
4. Restart every component — env changes never apply to running processes, and Compose containers keep stale env until recreated.
5. `EVELAND_IDENTITY_ALLOWED_ORIGINS` no longer has a development default (`http://localhost:3010`): set it explicitly if an external chat frontend depends on it.

Existing Deployments keep their recorded ports; new and restarted Deployment instances allocate from the new range.

## Single front door (origin merge)

Following the port block migration, the Agent Gateway became the single public
entry: it binds `17300` and serves the Dashboard, the browser API
(`/api/eveland/*`, fail-closed allowlist), Better Auth (`/api/auth/*`), and the
Identity issuer documents (`/.well-known/*`) on the platform host, plus Agent
traffic on wildcard Agent hosts. The API (`17301`) and Dashboard (`17302`)
moved to loopback behind it, and `/internal/*` machine-plane endpoints are no
longer reachable from any public interface.

Configuration collapsed into one variable: set `EVELAND_PUBLIC_ORIGIN` to the
browser-visible origin. `BETTER_AUTH_URL`, `WEB_ORIGIN`, and
`EVELAND_IDENTITY_ISSUER` derive from it (each remains available as an
explicit override); `NEXT_PUBLIC_API_URL` is gone — the browser always calls
the API same-origin, so nothing is baked into the web build any more.

For an existing installation:

1. Replace the per-service URLs in `.env` with one `EVELAND_PUBLIC_ORIGIN`.
2. Collapse your reverse proxy to a single upstream `127.0.0.1:17300` (the
   wildcard Agent router and the platform-host router share it) and close the
   old Dashboard/API ports on the firewall.
3. **Issuer migration**: Caller Token issuers must stay stable. Existing
   installs whose issuer was the API origin either keep it by setting
   `EVELAND_IDENTITY_ISSUER` explicitly to the old value (agents keep
   verifying old and new tokens; `/.well-known/*` must stay reachable at that
   origin), or move to the derived front-door issuer and accept that every
   consuming chat service and Agent verifier must be updated in step; the
   worker re-injects the new issuer into Deployments on its next reconcile.
4. Rebuild the web app and restart every component.

## Legacy per-project workflow residue

Every Release builds against the shared, external-only workflow world, and a production Worker refuses to start without `EVELAND_WORKFLOW_WORLD_URL`. Installs with history from before the shared World may still carry legacy per-project workflow configuration:

- Keep `WORKFLOW_POSTGRES_URL` (and `WORKFLOW_POSTGRES_BOOTSTRAP_URL`) configured only while legacy Projects are still being deleted — deleting a legacy Project is what drops its derived `eveland_wf_<project>_<digest>` database. Once no retained Deployment attests a legacy world and `pg_database` lists no `eveland_wf_*` databases other than the shared World itself, unset both variables; the legacy stream-retention sweep (`EVELAND_WORKFLOW_SWEEP_*`) then has nothing to do. Orphaned `eveland_wf_*` databases can be dropped with standard Postgres tooling. External-only installs never set these variables.

## Deeper reference

- [Backup and restore](/docs/operations/backup-restore): full data backup and disaster recovery procedures around upgrades
- [Eve compatibility window](/docs/reference/eve-compatibility): supported Eve version lines and dependency evolution
- [Runtime and resources](/docs/operations/runtime): instance lifecycle and attestation verification during release updates
