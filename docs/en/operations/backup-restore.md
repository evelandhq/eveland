---
title: Backup and restore
description: Back up the control-plane database, the shared workflow database, and the data root as one consistent set, and restore them in the right order.
---

Eveland ships no backup tooling of its own. Operators use standard `pg_dump`, `rsync`, or filesystem/volume snapshots. What Eveland defines is **what the state is** and **which pieces must stay consistent with each other**.

## What is state

Three stores plus configuration hold everything a restore needs:

1. **Control-plane Postgres** (`DATABASE_URL`): Projects, SourceRevisions, Releases, Deployments, routes, SessionBindings, ScheduleRuns, jobs, Team membership, and every encrypted Secret as AES-256-GCM ciphertext.
2. **The shared workflow database** (`EVELAND_WORKFLOW_WORLD_URL`): durable workflow runs, timers, streams, and per-run queues. It is part of platform state, not telemetry — losing it loses every in-flight and resumable durable run.
3. **The data root** (`EVELAND_DATA_DIR`, normally `/var/lib/eveland`): imported sources and uploads, built Release artifacts, deployment env files, Agent observability policies, managed Collector configuration and exporter queues, and the sandbox cache — which contains every durable session's `/workspace` state and is therefore data, not cache, despite the name.
4. **Configuration outside the database**: the Compose `.env`, `/etc/eveland/eveland-worker.env`, and the dispatcher env file. `APP_SECRET_KEY` deserves special care: database backups contain only ciphertext, so a backup without the key cannot recover any stored Secret. Keep the key material in your secret store, not only on the host.

An install still terminating pre-cutover history may also hold derived legacy `eveland_wf_*` databases; they remain state until retired (see [Upgrade and rollback](/docs/operations/upgrades)).

Both databases and the data root must come from the same point in time. Control-plane rows reference data-root paths (`sourcePath`, release directories) and shared-World tenants reference control-plane Deployments; a backup where one side has moved past the other leaves reconciliation pointing at objects that do not exist. Take backups inside a quiesced window (no running jobs or builds) or use snapshots that are mutually consistent.

## What not to back up

- **The npm cache** (`npm-cache/` below the data root) — rebuilt on demand.
- **The Eveland checkout and its `node_modules`** — reproducible from the release tag with `pnpm install --frozen-lockfile`.
- **Collector exporter queues** (below `otel/` in the data root) — excluding them loses only undelivered telemetry, never platform state.

Built Release artifacts (`builds/`) are _not_ safely excludable: a Release is immutable and cold activation starts the exact artifact on disk. Excluding builds means every Deployment needs a new build and promote after restore, and historical Release provenance is gone. Back up the whole data root and exclude only the npm cache unless you accept that cost.

## Restore ordering

1. Stop all five components (Dashboard, API, Agent Gateway, Worker, Workflow Dispatcher) and keep public ingress closed.
2. Restore the control-plane database and the shared workflow database from the same backup window.
3. Restore the data root at the **same absolute path** — API's mounted path and Worker's `EVELAND_DATA_DIR` must agree, and stored `sourcePath` values are absolute.
4. Restore configuration files, check out the exact release tag the backup was taken under, and install the frozen lockfile. Restore onto the same version first; upgrade afterwards through the normal [upgrade path](/docs/operations/upgrades).
5. Start Postgres, then the core services, the dispatcher, and Worker. Worker reconciles stale `ready` RuntimeInstances to `stopped` or `failed`; nothing restarts by itself.
6. Send a real request or wait for a schedule: the next activation cold-starts the preserved exact Release. Verify identity and health per **Settings → About** before reopening ingress.

## Host reboot recovery

A reboot is not a restore case. systemd Deployment processes are transient units and deliberately do not restart after a host reboot. The enabled Worker service does restart, reconciles stale `ready` RuntimeInstances to `stopped`/`failed`, and the next cron or Agent Gateway request cold-starts the preserved exact Release. The immutable Deployment, routes, history, and SessionBindings survive; only the transient process is absent during the cold interval.
