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

## Identity and Catalog paths moved into `/api`

The issuer-anchored public endpoints moved from the origin root into the
`/api` namespace, with no transition alias:

| Old path                      | New path                 |
| ----------------------------- | ------------------------ |
| `/identity/*`                 | `/api/identity/*`        |
| `/identity/internal/continue` | `/api/identity/continue` |
| `/agent-catalog`              | `/api/agent-catalog`     |

`/.well-known/jwks.json` and `/api/auth/*` are unchanged. The
`eveland_identity` cookie's `Path` moved with the routes (existing sessions
simply re-login). For an existing installation:

1. **Agents must run `eveland` ≥ 0.6 and be rebuilt.** Older SDKs bake
   `${issuer}/identity/login` into their `WWW-Authenticate` challenge, which
   now resolves to the Dashboard; rebuild and promote every Project after the
   platform upgrade.
2. **Re-register the OIDC redirect URI** at your IdP as
   `<identityIssuer>/api/identity/oidc/callback` (Settings → System →
   Identity surfaces the exact value).
3. Update any external chat client configuration that pointed at
   `/agent-catalog` or `/identity/*` on the public origin.

In the same series, the Dashboard's own browser API left the
`/api/eveland/<subtree>` tunnel: the API now registers its whole public
surface natively under `/api/*` and the front door forwards that namespace
verbatim (the allowlist is gone — the machine plane stays at root
`/internal/*`, which the front door never forwards). This is invisible to
operators and external clients; only custom tooling that scripted
`/api/eveland/...` URLs needs the prefix dropped.

## Better Auth account issuer

The bundled Better Auth 1.7 line matches credential sign-ins on a new
`auth_accounts.issuer` column. Migration `0058` adds it with an inline
`DEFAULT 'local:credential'`, so apply order is the usual one — **migrate,
then restart the API** — and a rollback to a pre-upgrade checkout keeps
writing accounts cleanly (old code omits the column; the default fills it).

Before upgrading, verify the credential invariant the new sign-in relies on
(it holds in every supported write path; a nonzero count means manually
repaired rows):

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM auth_accounts WHERE provider_id='credential' AND account_id<>user_id"
```

## CLI device authorization tables

Migration `0059` creates the `auth_device_codes` and `oauth_*` tables backing
`eveland login` (RFC 8628 device flow with scoped OAuth access tokens). It only
creates new tables — the usual **migrate, then restart** order applies, and a
rollback is unaffected (old code never touches them). On boot the API seeds and
re-asserts the `eveland-cli` OAuth client row; do not hand-edit it.

## Log tail/cursor sequence column

Migration `0060` adds a monotonic `seq` column to `logs` backing the bounded
log-read protocol (`limit` tail, `after` cursor) the CLI uses, replaces the
old `(project_id, created_at)` index with seq-based ones, and backfills
historical rows deterministically in `(created_at, id)` order.

**This is a stop-the-world migration for the `logs` table.** The migration
runs in a single transaction, so the exclusive lock taken by the column add
is held through the full-table backfill: every log read and write — build
and runtime log appends included — blocks until it commits, for a duration
proportional to the log history. Run it in a quiet window, or stop the
platform components first (the safest order: stop, migrate, restart). The
staged statements exist for a single write pass and deterministic ordering,
not to make the migration online.

## Session identity unique index

Migration `0061` makes `sessions(project_id, eve_session_id)` unique, so the
schema enforces the Session identity every OTLP ingest and every continuation
already resolves through. Installs from before it can hold duplicate pairs (a
Playground completion or a ScheduleRun completion that raced ingest); the
migration folds them before creating the index, with the rules the platform's
own placeholder merge applies: the older row survives, the newer row's nodes,
events (renumbered after the survivor's), usage rows, and ScheduleRun links move
onto it, usage counters are summed, and metadata gaps fill from the absorbed row.

The migration refuses — with the query to list the offending rows in its hint —
when two rows carry the same model usage step, because folding would count it
twice. Delete the newer Session's duplicated usage rows (or the newer Session)
and re-run. Check for duplicates before upgrading with:

```sql
select project_id, eve_session_id, count(*)
from sessions
where eve_session_id is not null
group by 1, 2
having count(*) > 1;
```

## API off host networking

This release moves the API off host networking. In the production overlay it
runs on the Compose network, publishes only `127.0.0.1:17301`, and the managed
Collector addresses it as `http://api:17301`. A host-network API can satisfy the
loopback-only port contract or the Collector's reach, never both — the
Observation path stayed silently disconnected as long as it tried. Agent
Gateway and the Dashboard keep host networking, because the front door still
dials Deployments on the host's loopback ports.

For an existing installation:

1. Give the API its own dialable address for the shared workflow database. An
   API on the Compose network cannot reach the host loopback publish that
   `EVELAND_WORKFLOW_WORLD_URL` named at the time, and without a reachable
   World the readiness gate resolves its cluster identity to `unknown` and
   refuses every workflow-step activation with `workflow_unavailable`. Upgrading
   past this release resolves it for good — see
   [Postgres moved out of Compose](#postgres-moved-out-of-compose), where one
   external address serves the API, the host processes, and every Deployment.
2. Recreate the containers rather than restarting them — a network mode and a
   published port only change on recreate:
   `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`.
3. The host Worker, the workflow dispatcher, and the front door keep reaching
   the API at `http://127.0.0.1:17301`.
4. Confirm both paths afterwards: a Session that records events and token usage
   proves the Collector reaches the API, and `Workflow dispatch` on the Instance
   health page leaving `unavailable` proves the API reaches the World.

## Docker Agent runtime retired on Linux

The `docker-worker` Compose profile is gone, and Linux production supports the
systemd Agent runtime only. `EVELAND_RUNTIME=docker` remains the development
runtime and the macOS appliance's — only the Linux production form dropped it.

An installation still running Docker-runtime Agents on Linux must migrate
**before** upgrading:

1. Drain and stop every Docker Deployment. Each Deployment records the
   `runtimeKind` that created it and lifecycle operations resolve their adapter
   from that recorded value, so a Docker Deployment left behind on a systemd
   host fails loudly as a logged job failure — mixed hosts are visible, never a
   supported topology.
2. Install the host Worker and the workflow dispatcher per
   [Install the host Worker](/docs/production/worker) and
   [Install the workflow dispatcher](/docs/production/workflow-dispatcher).
3. Redeploy each Project so its Deployments are recreated under the systemd
   runtime.

The production overlay now gates the base file's development Worker behind a
profile the production command never enables, mirroring the workflow
dispatcher, so the merged configuration cannot start a second runtime
controller.

## Postgres moved out of Compose

**Breaking.** Linux production no longer runs Postgres in Docker Compose. The
base file's database is gated behind a profile the production command never
enables, and `DATABASE_URL` and `EVELAND_WORKFLOW_WORLD_URL` are now required
in `.env` — Compose refuses to start without them. `EVELAND_WORKFLOW_WORLD_COMPOSE_URL`
is gone; delete it — at step 5 below, not before.

Why: this form runs code in three network namespaces at once — the Compose
bridge (API), the host (Agent Gateway, Dashboard, Worker, dispatcher), and every
Deployment's own host process. A Compose-hosted database is dialable from all
three only under three different addresses, so each database needed a
per-namespace view and every consumer had to be told which one it held. An
external instance has one address that resolves the same everywhere.

Local development and the macOS `eveland-ctl` appliance are unchanged: both run
every platform process in the host namespace, so their Compose Postgres stays
exactly as it was.

To migrate, two things decide the exact commands: how this installation is
managed, and how many databases it actually has.

**Which files name the database.**

- **`eveland-ctl` appliance** — one file, `/opt/eveland/etc/eveland.env`. Every
  start re-renders the Worker's, the dispatcher's, the Gateway's and the
  Dashboard's own environments from it, so it is the only one to edit, and
  `eveland-ctl update` moves the checkout.
- **Hand-managed** — the Compose `.env` plus `/etc/eveland/eveland-worker.env`
  and `/etc/eveland/eveland-workflow-dispatcher.env`, each edited by hand, and
  `git` moves the checkout.

**How many databases.** An appliance that `eveland-ctl` installed has exactly
one: it rendered `DATABASE_URL` and `EVELAND_WORKFLOW_WORLD_URL` at the same
`eveland` database, and the platform's tables and the World's tables live there
together. Nothing in this change requires two — two DSNs may name one database,
which is what the macOS appliance does — so the safest migration is the one that
keeps the topology already in place. Read it off the configuration rather than
assuming:

```bash
grep -E '^(DATABASE_URL|EVELAND_WORKFLOW_WORLD_URL)=' /opt/eveland/etc/eveland.env
```

1. Prepare the external instance per
   [Prepare the host](/docs/production/prerequisites#provision-an-external-postgres):
   an address dialable as written from the Compose bridge and the host alike, no
   transaction-pooling proxy in front of it, and `postgresql-client` installed on
   this host for `pg_dump`. Create a database for each distinct one the previous
   step listed.
2. Copy the data across **while the old stack is still up**: this dump, and the
   pre-update backup in step 4, both run `pg_dump` inside the Compose container,
   which a fully stopped platform no longer has. Stop only what writes.

   ```bash
   compose="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
   $compose stop api gateway web
   sudo systemctl stop eveland-worker eveland-workflow-dispatcher
   # One line per database the previous step listed -- usually just this one.
   $compose exec -T postgres pg_dump -U eveland -d eveland \
     | psql 'postgres://eveland:<password>@db.internal:5432/eveland'
   ```

   `workflow_stream_chunks` dominates the dump and is recoverable state, not
   history — `truncate table workflow_stream_chunks;` before dumping cuts most
   of the volume. It costs the replayable stream of already-finished runs,
   nothing an in-flight run needs.

3. Repoint the configuration, **before any code from this version starts**, so
   `DATABASE_URL` and `EVELAND_WORKFLOW_WORLD_URL` hold the external addresses,
   character for character, in every file the layout above lists.

   **Leave `EVELAND_WORKFLOW_WORLD_COMPOSE_URL` in place for now.** The version
   being replaced interpolates it as `${EVELAND_WORKFLOW_WORLD_COMPOSE_URL:?}`,
   so deleting it here makes every remaining `docker compose` command on that
   version fail outright — the pre-update backup in step 4 included.

   Quote each value: Compose expands `$NAME` inside an unquoted `--env-file`
   value while the host's readers take it literally, so a password containing
   `$` reaches the containerized API truncated and every host process intact.
   `DATABASE_URL='postgres://…'` is read the same by all of them.

4. Move to this version.

   - Appliance: `sudo eveland-ctl update`.
   - Hand-managed: update the checkout, then **recreate** the containers rather
     than restarting them — an environment change only reaches a container on
     recreate — and start the host units again:

     ```bash
     docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
     sudo systemctl start eveland-worker eveland-workflow-dispatcher
     ```

5. Delete `EVELAND_WORKFLOW_WORLD_COMPOSE_URL`. Nothing on this version reads
   it, so it is inert rather than harmful — but a stale address left in the
   configuration is one the next operator has to disprove.
6. **Restart every running Deployment.** A Deployment receives the world
   address at launch, and activation deliberately reuses a unit that is
   already serving its port rather than re-rendering it — so an Agent that was
   running through the switch keeps dialing the old address forever, and only
   its durable workflow steps fail. Restart each one through the Dashboard or
   `eveland`; that path recomposes the environment from the Worker's current
   configuration. Check one afterwards:

   ```bash
   sudo cat /proc/$(systemctl show -p MainPID --value eveland-<project>-<deployment>)/environ \
     | tr '\0' '\n' | grep EVELAND_WORKFLOW_WORLD_URL
   ```

7. Verify: **Settings → About** agrees across components, `Workflow dispatch`
   on the Instance health page is not `unavailable`, and a Session records
   events and token usage.
8. Retire the old container. `docker compose up -d` no longer starts it, but it
   does not stop one that is already running either — and because the service
   now sits behind a profile, a plain `docker compose stop postgres` exits 0
   having done nothing. Address it through the profile:

   ```bash
   compose="docker compose --profile dev-postgres -f docker-compose.yml -f docker-compose.prod.yml"
   $compose stop postgres && $compose rm -f postgres
   ```

   Leaving it up is the exact failure this change exists to prevent: a second
   cluster still answering on `17310`, ready to absorb any process that still
   holds the old DSN. Keep its volume until the new instance has proven itself,
   then remove that too.

## Legacy per-project workflow residue

Every Release builds against the shared, external-only workflow world, and a production Worker refuses to start without `EVELAND_WORKFLOW_WORLD_URL`. Installs with history from before the shared World may still carry legacy per-project workflow configuration:

- Keep `WORKFLOW_POSTGRES_URL` (and `WORKFLOW_POSTGRES_BOOTSTRAP_URL`) configured only while legacy Projects are still being deleted — deleting a legacy Project is what drops its derived `eveland_wf_<project>_<digest>` database. Once no retained Deployment attests a legacy world and `pg_database` lists no `eveland_wf_*` databases other than the shared World itself, unset both variables; the legacy stream-retention sweep (`EVELAND_WORKFLOW_SWEEP_*`) then has nothing to do. Orphaned `eveland_wf_*` databases can be dropped with standard Postgres tooling. External-only installs never set these variables.

## Deeper reference

- [Backup and restore](/docs/operations/backup-restore): full data backup and disaster recovery procedures around upgrades
- [Eve compatibility window](/docs/reference/eve-compatibility): supported Eve version lines and dependency evolution
- [Runtime and resources](/docs/operations/runtime): instance lifecycle and attestation verification during release updates
