---
title: Upgrades and rollbacks
description: Standard platform upgrade procedures, backup requirements, rollback rules, and milestone migration notes.
---

Eveland comprises five core service components (API, Agent Gateway, Dashboard, Worker, and Workflow Dispatcher). When upgrading, treat the platform as a **single coordinated system**, ensuring all services run the same release tag and git revision.

For release-specific compatibility notes and changelogs, consult [GitHub Releases](https://github.com/evelandhq/eveland/releases).

---

## 1. Pre-upgrade preparations

1. **Review target Release Notes**: Check for any breaking changes or manual migration requirements.
2. **Execute backups**: Back up the control plane database, workflow database, and data directory (see [Backup and restore](/docs/operations/backup-restore)).
3. **Verify current health**: In the dashboard under **Settings → About**, verify that all running components are aligned and healthy.

---

## 2. Standard upgrade workflow

### If you used the installer (the normal case)

One command backs up the databases, moves to the newest release, applies migrations, and restarts the platform:

```bash
eveland-ctl update
```

Pin a specific release with `--version vX.Y.Z`. Re-running `curl -fsSL https://eveland.ai/install.sh | sudo bash` on an installed machine does the same thing — it forwards to `eveland-ctl update`.

### If you installed by hand

For git checkouts and systemd units you manage yourself. (To stop doing this, see [migrating a hand-installed platform onto the installer](/docs/production/install#coming-from-an-older-hand-installed-platform).)

```bash
# 1. Checkout the target release tag
cd /opt/eveland
git fetch --tags origin
git checkout vX.Y.Z

# 2. Install frozen lockfile and build web dashboard
pnpm install --frozen-lockfile
pnpm --filter @evelandhq/web build

# 3. Apply database migrations (must run before restarting services)
pnpm --filter @evelandhq/api db:migrate

# 4. Restart core systemd services
sudo systemctl restart eveland-api eveland-gateway eveland-web eveland-worker eveland-workflow-dispatcher
```

---

## 3. Post-upgrade verification

1. **Component revision alignment**: In **Settings → About**, verify that API, Dashboard, Worker, and Dispatcher all report the new `version` and `revision`.
2. **End-to-end verification**: In a test project, trigger a **Build & Deploy** and verify dialogue turns and streaming responses in the Playground.

---

## 4. Rollback guidelines

- **Schema compatibility**: Rolling back to an older git tag is safe only if the older codebase is backward-compatible with the applied database migrations. PostgreSQL migrations do not automatically roll back.
- **System-wide alignment**: Always roll back all five components together; never run mixed versions across services.

---

## 5. Moving the workflow world out of the platform database

Installations configured before the split — `eveland-ctl` rendered both DSNs against the same database until this release — have `EVELAND_WORKFLOW_WORLD_URL` naming the platform's own database. `eveland-ctl doctor` reports this as `workflow-world-database`. It matters because the world's DSN is injected into every agent deployment: agent code holds those credentials, and through them the accounts, sessions, and encrypted project secrets.

Nothing repoints it for you: the runs, timers, and hooks already in flight live in the `workflow` schema of the database currently in use, and a silent switch would strand them. Move them deliberately, with the platform stopped:

```bash
eveland-ctl stop
createdb -h 127.0.0.1 -p 17310 -U eveland eveland_workflow
pg_dump -h 127.0.0.1 -p 17310 -U eveland -n workflow eveland \
  | psql -h 127.0.0.1 -p 17310 -U eveland eveland_workflow
```

Then point every component at the new database — `EVELAND_WORKFLOW_WORLD_URL` (and `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL` where it is set) in `etc/eveland.env`, or in `eveland-worker.env` and `eveland-workflow-dispatcher.env` on a manual systemd install — and start again. Verify with `eveland-ctl doctor`, then drop the old schema once a deploy and a workflow run have both succeeded:

```sql
DROP SCHEMA workflow CASCADE;
DROP SCHEMA graphile_worker CASCADE;
```

Deployments keep the old DSN until they are rebuilt, so rebuild each agent (**Build & Deploy**) after the move; until then their durable runs still write to the old database.

---

## 6. Architectural milestone reference

If you are upgrading across multiple major versions, note these architectural milestones:

- **Single front door (Origin consolidation)**: All console and agent traffic converges onto the Agent Gateway (default: `17300`). Browsers reach the platform via `EVELAND_PUBLIC_ORIGIN`, eliminating frontend API baking.
- **Dedicated port block**: Platform services moved to dedicated port ranges (API: `17301`, Gateway: `17300`, bundled Postgres: `17310`, dynamic agent ports: `18000–18999`).
- **`/api` namespace alignment**: Identity and catalog endpoints reside under `/api/` (e.g. `/api/identity/*` and `/api/agent-catalog`).
- **Shared Workflow World**: Deployments share a single `@evelandhq/workflow-world` database rather than physical per-project databases.

## Deeper reference

- [Backup and restore](/docs/operations/backup-restore): full backup and disaster recovery procedures
- [Runtime and resources](/docs/operations/runtime): deployment lifecycles and workflow retention classes
- [Configuration reference](/docs/reference/configuration): component environment variable ownership
