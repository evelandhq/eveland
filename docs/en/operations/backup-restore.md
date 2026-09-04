---
title: Backup and restore
description: Backup strategy and disaster recovery procedures for platform control plane databases, workflow state, and data roots.
---

Eveland does not bundle proprietary backup tools. Operators should utilize standard tools (e.g. `pg_dump`, `rsync`, or cloud storage volume snapshots).

For a consistent disaster recovery, you must know **what constitutes persistent platform state** and **the required restoration ordering**.

---

## 1. Core state checklist

A consistent backup requires the following three components captured from the **exact same point in time**:

| State Component              | Storage & Path                            | Core Content                                                                                                 |
| :--------------------------- | :---------------------------------------- | :----------------------------------------------------------------------------------------------------------- |
| **Control Plane Database**   | PostgreSQL (`DATABASE_URL`)               | Project metadata, releases, deployment history, routes, team auth, and AES-256 encrypted secrets.            |
| **Shared Workflow Database** | PostgreSQL (`EVELAND_WORKFLOW_WORLD_URL`) | Durable workflow execution states, timers, and step queues.                                                  |
| **Persistent Data Root**     | Host filesystem (`/var/lib/eveland`)      | Source archives, immutable releases (`builds/`), telemetry configs, and persistent `/workspace` directories. |

_Security Warning: Decrypting stored secrets requires the host `APP_SECRET_KEY`. Ensure this master key is safely backed up in an external secret manager (KMS / Vault)._

---

## 2. Excluded ephemeral paths

When creating filesystem snapshots, exclude these temporary caches:

- **npm cache directory** (`EVELAND_DATA_DIR/npm-cache/`): Rebuilt on demand;
- **Platform checkout and dependencies** (`/opt/eveland` & `node_modules`): Fully reproducible via git tag and `pnpm install --frozen-lockfile`;
- **OTel Collector exporter queues** (`EVELAND_DATA_DIR/otel/`): Transient telemetry buffers.

_Note: Compiled releases in `builds/` **must be backed up**. Cold starts execute the exact build artifact from disk. If missing, all deployments must be manually rebuilt and promoted._

---

## 3. Disaster recovery workflow

When restoring onto a new host or recovering from a hardware failure:

```bash
# Step 1: Stop all Eveland platform units
sudo systemctl stop eveland-api eveland-gateway eveland-web eveland-worker eveland-workflow-dispatcher

# Step 2: Restore PostgreSQL databases (control plane and workflow databases)
# Example: pg_restore from backup dump

# Step 3: Restore the data root onto the identical absolute path (e.g. /var/lib/eveland)

# Step 4: Checkout the recorded release tag and install dependencies
cd /opt/eveland
git checkout vX.Y.Z
pnpm install --frozen-lockfile

# Step 5: Start Postgres and core services
sudo systemctl start eveland-api eveland-gateway eveland-web eveland-worker eveland-workflow-dispatcher

# Step 6: Verify platform health
# Open Settings → About in the dashboard to confirm aligned versions, then send a test request
```

---

## 4. Host reboot handling

A normal host reboot does **not** require a disaster recovery restore:

- Agent deployments run as transient systemd services and do not restart on boot by design.
- On host startup, the Worker automatically launches, marking offline instances as `stopped`.
- The first inbound request triggers an automated cold start, restoring service with zero manual intervention.

## Deeper reference

- [Upgrades and rollbacks](/docs/operations/upgrades): version upgrade checklists and database migrations
- [Capacity planning](/docs/operations/capacity): storage sizing for releases and persistent workspaces
- [Security model](/docs/operations/security): master encryption key protection
