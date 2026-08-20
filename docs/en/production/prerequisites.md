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

## Provision Postgres

Production uses two databases, normally on one instance:

- **Platform database** (`DATABASE_URL`) — owns Projects, Deployments, jobs, and auth. Configure a dedicated role.
- **Shared workflow database** (`EVELAND_WORKFLOW_WORLD_URL`) — one database backing `@evelandhq/workflow-world` for every Project, scoped internally by `tenant_id`. It is required in production: Worker fails startup closed without it, and API reads the same URL to verify the World's cluster identity. Worker startup and tenant provisioning apply all pending workflow-world migrations automatically, serialized by a PostgreSQL advisory lock; set `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL` when the host reaches the database through a different address than Deployments do.

Do not create per-project workflow databases: the shared World replaced them. The legacy `WORKFLOW_POSTGRES_URL` is only relevant to installs still terminating pre-cutover Deployments — see [Upgrade and rollback](/docs/operations/upgrades).

Size `max_connections` and per-Deployment pool budgets with [Capacity planning](/docs/operations/capacity) before the first real workload, and put both databases plus the data root on your backup schedule — see [Backup and restore](/docs/operations/backup-restore).

## Run preflight

Run the standalone check from the Worker checkout:

```bash
pnpm --filter @evelandhq/worker exec tsx src/integration/preflight-check.ts
```

It verifies the full host contract in one pass: Linux with systemd, running as root, an absolute `EVELAND_DATA_DIR`, `systemd-run`, `systemctl`, `runuser`, `docker`, `ss`, and `ps` on `PATH`, the complete sandbox toolchain (`bash`, `node`, `npm`, `pnpm`, `rg`, GNU `grep`/`find`, `git`, `curl`, `jq`, `python`/`python3`, `pip`/`pip3`, `unzip`, `zstd`), `bwrap` unless `EVELAND_BUILD_SANDBOX=none`, the app and build users existing, `/workspace` existing as a directory, `@evelandhq/sandbox-bwrap` being resolvable, and the app user being able to traverse the data dir.

It reports every failing check at once instead of stopping at the first. Do not continue until it prints `PREFLIGHT OK`.

Continue with [Install the core services](/docs/production/core-services).
