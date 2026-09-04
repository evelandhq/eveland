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

## 5. Architectural milestone reference

If you are upgrading across multiple major versions, note these architectural milestones:

- **Single front door (Origin consolidation)**: All console and agent traffic converges onto the Agent Gateway (default: `17300`). Browsers reach the platform via `EVELAND_PUBLIC_ORIGIN`, eliminating frontend API baking.
- **Dedicated port block**: Platform services moved to dedicated port ranges (API: `17301`, Gateway: `17300`, bundled Postgres: `17310`, dynamic agent ports: `18000–18999`).
- **`/api` namespace alignment**: Identity and catalog endpoints reside under `/api/` (e.g. `/api/identity/*` and `/api/agent-catalog`).
- **Shared Workflow World**: Deployments share a single `@evelandhq/workflow-world` database rather than physical per-project databases.

## Deeper reference

- [Backup and restore](/docs/operations/backup-restore): full backup and disaster recovery procedures
- [Runtime and resources](/docs/operations/runtime): deployment lifecycles and workflow retention classes
- [Configuration reference](/docs/reference/configuration): component environment variable ownership
