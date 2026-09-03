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

## Choose a PostgreSQL

An installation either runs the bundled database or uses one you provide. `eveland-ctl` asks once, at first boot, and records the answer in `install.json`; every later command branches on that record rather than guessing from the connection URL.

- **Bundled** — the Compose `postgres` service, published on host loopback `17310`. Nothing to provision, and upgrades dump it inside its own container, where the client and server versions match by construction. Suitable for a single-box installation.
- **Your own** (recommended for anything you would page someone about) — a managed instance or a server you already operate, so backups, failover, and version upgrades follow the practices you already have. Answer the first-boot prompt with its connection URL, or set `DATABASE_URL` in the environment before the first `eveland-ctl start`.

There is no automatic fallback in either direction. If you name a server and it does not answer, the install stops there with the connection error rather than quietly starting a bundled container beside it — two clusters, one holding half the data, is not a state worth reaching.

What the platform needs from your own server is a role that owns two databases (or, as `eveland-ctl` renders it, one database used for both):

- **Platform database** (`DATABASE_URL`) — owns Projects, Deployments, jobs, and auth.
- **Shared workflow database** (`EVELAND_WORKFLOW_WORLD_URL`) — one database backing `@evelandhq/workflow-world` for every Project, scoped internally by `tenant_id`. It is required in production: Worker fails startup closed without it, and API reads the same URL to verify the World's cluster identity. Worker startup and tenant provisioning apply all pending workflow-world migrations automatically, serialized by a PostgreSQL advisory lock.

Every reader of these — API, Agent Gateway, Worker, dispatcher, and every Deployment — is a host process in one network namespace, so each URL is a single address. `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL` exists only for a platform that reaches the database by a different name than its Deployments do, which on Linux is no longer the case.

CREATEDB is not required. A Project is a tenant partition inside the shared World; only the legacy termination path still issues `CREATE DATABASE`. Do not create per-project workflow databases: the shared World replaced them. The legacy `WORKFLOW_POSTGRES_URL` is only relevant to installs still deleting Projects from before the shared World — see [Upgrade and rollback](/docs/operations/upgrades).

Do not put a transaction-pooling proxy (PgBouncer in `transaction` mode, and most "serverless" pool front-ends) in front of either database: the durable job queue depends on session-scoped `LISTEN`/`NOTIFY` and advisory locks, which transaction pooling silently drops.

An installation on its own PostgreSQL also needs `pg_dump` on the host, because `eveland-ctl update` takes a pre-upgrade backup with it (Debian/Ubuntu: `apt-get install postgresql-client`). `eveland-ctl doctor` checks for it, so a missing client is a finding rather than a failure halfway through an upgrade.

Size `max_connections` and per-Deployment pool budgets with [Capacity planning](/docs/operations/capacity) before the first real workload, and put both databases plus the data root on your backup schedule — see [Backup and restore](/docs/operations/backup-restore).

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
