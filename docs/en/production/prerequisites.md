---
title: Prepare the host
description: Prepare Linux users, directories, the sandbox toolchain, storage, and database access before installation.
---

Use a Linux host with systemd; Eveland is verified on Ubuntu 24.04. Worker treats the complete toolchain below as a deployment contract and refuses to start while any piece is missing.

## Install the toolchain

Install Node.js 24 (e.g. from NodeSource), then the pinned package-manager shim:

```bash
sudo corepack enable
sudo corepack install --global pnpm@11.7.0
```

Install the host-owned sandbox toolchain. Ubuntu's base image happens to include some of these commands, but the Worker preflight checks the complete set:

```bash
sudo apt-get install -y apparmor bash bubblewrap ca-certificates curl docker.io findutils git grep jq python-is-python3 python3 python3-pip ripgrep unzip zstd
```

`git` is required in any case: Worker shells out to `git clone` for source imports.

## Configure bubblewrap and AppArmor

Ubuntu's packaged bubblewrap ships **no** AppArmor profile, and Ubuntu sets `kernel.apparmor_restrict_unprivileged_userns=1` by default, which blocks an unconfined non-root process from creating a user namespace. Both the build sandbox (running as the unprivileged build user) and the Agent exec sandbox (running as the unprivileged Deployment user) are exactly that, so both need a profile granting `bwrap` the `userns` permission:

```
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/bwrap>
}
```

Save this as `/etc/apparmor.d/bwrap` and load it with `apparmor_parser -r -W /etc/apparmor.d/bwrap` (safe to re-run; it replaces an already-loaded profile). A distro whose bubblewrap package ships its own profile, or a host with the sysctl disabled, needs none of this.

## Create users and directories

- Create `/workspace` as an empty directory: `sudo install -d -m 0755 /workspace`. bwrap binds each sandbox session directory onto `/workspace` inside the sandbox but cannot create that mountpoint itself, because the sandboxed process bind-mounts the host root read-only first.
- Create the artifact-access user and same-named group:
  `sudo useradd --system --user-group --home-dir /var/lib/eveland-app --create-home eveland-app`.
  Each Deployment runs under its own systemd `DynamicUser`; those identities use `eveland-app` only as their primary access group for the explicitly bound Release, cache, and policy paths.
- Create a second service user for builds:
  `sudo useradd --system --home-dir /var/lib/eveland-build --create-home eveland-build`.
  Dependency lifecycle scripts (`npm ci`/`npx eve build`) run as this user inside the build sandbox, never as root.
- Create the absolute data root, normally `/var/lib/eveland`. API's mounted path and Worker's `EVELAND_DATA_DIR` must use that exact absolute path.

Worker itself must run as root (it drives `systemd-run`, `systemctl`, and `chown`); it is installed as a systemd service in [Install the host Worker](/docs/production/worker).

## Provision an external Postgres

**Postgres is a prerequisite of this topology, not part of it.** Production runs code in three network namespaces at once — the Compose bridge (API), the host (Agent Gateway, Dashboard, Worker, workflow dispatcher), and every Deployment's own host process. A Compose-hosted database is dialable from all three only under three different addresses, so each database would need a per-namespace view and every consumer would have to be told which view it held. An instance outside the installation has one address that resolves the same everywhere, which is why each database here is a single DSN.

Provision an instance and create two databases on it before installing:

- **Platform database** (`DATABASE_URL`) — owns Projects, Deployments, jobs, and auth. Configure a dedicated role that owns it.
- **Shared workflow database** (`EVELAND_WORKFLOW_WORLD_URL`) — one database backing `@evelandhq/workflow-world` for every Project, scoped internally by `tenant_id`. It is required in production: Worker fails startup closed without it, and API reads the same URL to verify the World's cluster identity. Worker startup and tenant provisioning apply all pending workflow-world migrations automatically, serialized by a PostgreSQL advisory lock.

Both databases must exist before the first start; nothing in the platform creates them. The role does **not** need `CREATEDB`: a new Project becomes a tenant partition inside the shared World, never a database of its own. Only an install still carrying the legacy `WORKFLOW_POSTGRES_URL` needs `CREATE`/`DROP DATABASE`, and only to finish deleting Projects that predate the shared World — see [Upgrade and rollback](/docs/operations/upgrades).

Requirements on the instance itself:

- **One address, reachable as written from everywhere.** The same `DATABASE_URL` and `EVELAND_WORKFLOW_WORLD_URL` strings go into the API's Compose environment, `eveland-worker.env`, and `eveland-workflow-dispatcher.env`, and reach every Deployment. A host loopback address does not qualify: inside the API container that is the container's own loopback.
- **No transaction-pooling proxy in front of it.** The workflow queue depends on `LISTEN`/`NOTIFY`, which transaction pooling breaks outright — a dispatcher behind PgBouncer in `transaction` mode silently stops waking runs. Use session pooling or a direct connection.
- **A connection budget that accounts for Deployments.** Every running Agent holds a set of long-lived connections of its own; `WORKFLOW_POSTGRES_MAX_POOL_SIZE` is the lever. Size `max_connections` and per-Deployment pool budgets with [Capacity planning](/docs/operations/capacity) before the first real workload.
- **`postgresql-client` installed on the host.** `eveland-ctl update` takes a `pg_dump` backup before it moves the checkout, and it runs on the host, not inside a container. Install it with `sudo apt-get install -y postgresql-client`, and keep it at least as new as the server — `pg_dump` refuses outright against a newer one.

Put both databases plus the data root on your backup schedule — see [Backup and restore](/docs/operations/backup-restore).

## Run preflight

Run the standalone check from the Worker checkout:

```bash
pnpm --filter @evelandhq/worker exec tsx src/integration/preflight-check.ts
```

It verifies the full host contract in one pass: Linux with systemd, running as root, an absolute `EVELAND_DATA_DIR`, `systemd-run`, `systemctl`, `runuser`, `docker`, `ss`, and `ps` on `PATH`, the complete sandbox toolchain (`bash`, `node`, `npm`, `pnpm`, `rg`, GNU `grep`/`find`, `git`, `curl`, `jq`, `python`/`python3`, `pip`/`pip3`, `unzip`, `zstd`), `bwrap` unless `EVELAND_BUILD_SANDBOX=none`, the app and build users existing, `/workspace` existing as a directory, `@evelandhq/sandbox-bwrap` being resolvable, and the app user being able to traverse the data dir.

It reports every failing check at once instead of stopping at the first. Do not continue until it prints `PREFLIGHT OK`.

Continue with [Install the core services](/docs/production/core-services).

## Deeper reference

- [Production architecture](/docs/production): core services, host Worker, and systemd topology
- [Why a bubblewrap sandbox](/docs/reference/design/sandbox): AppArmor configuration and sandbox self-check rationale
- [Capacity planning](/docs/operations/capacity): host hardware sizing and Postgres connection budgets
- [Troubleshooting](/docs/reference/troubleshooting#worker-will-not-start): preflight failure diagnosis and resolution steps
