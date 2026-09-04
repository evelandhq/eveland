---
title: Host prerequisites
description: Prepare Linux host dependencies, bubblewrap sandboxing, dedicated system users, and PostgreSQL planning.
---

Production environments require a Linux host with systemd (Ubuntu 24.04 LTS recommended). Complete the following preparations before installing Eveland platform services.

## 1. Install toolchain and dependencies

### Node.js and package manager

Install Node.js 24 and enable the required pinned pnpm version via Corepack:

```bash
sudo corepack enable
sudo corepack install --global pnpm@11.7.0
```

### System packages and sandboxing utilities

The host Worker requires basic Linux packages for git imports, packaging, and unprivileged sandboxing:

```bash
sudo apt-get update && sudo apt-get install -y \
  apparmor bubblewrap ca-certificates curl docker.io \
  findutils git grep jq python-is-python3 python3 python3-pip \
  ripgrep unzip zstd
```

## 2. Configure bubblewrap and AppArmor

Ubuntu 24.04 restricts unprivileged user namespaces by default (`kernel.apparmor_restrict_unprivileged_userns=1`). Because both build sandboxes and runtime exec environments run as unprivileged users, create an AppArmor profile granting `bwrap` necessary permissions:

Create `/etc/apparmor.d/bwrap`:

```text
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
```

Reload AppArmor to apply the profile:

```bash
sudo apparmor_parser -r -W /etc/apparmor.d/bwrap
```

_(If your Linux distribution already includes a profile or does not restrict unprivileged user namespaces, you can skip this step.)_

## 3. Create dedicated users and directories

- **Sandbox mount root**: Create `/workspace` for mounting isolated sandbox sessions:
  ```bash
  sudo install -d -m 0755 /workspace
  ```
- **Application group user**: Create `eveland-app` for managing release artifacts and deployment caches:
  ```bash
  sudo useradd --system --user-group --home-dir /var/lib/eveland-app --create-home eveland-app
  ```
- **Dedicated build user**: Create `eveland-build`. Untrusted dependency scripts (`npm ci`, `npx eve build`) always run under this unprivileged account, preventing privilege escalation:
  ```bash
  sudo useradd --system --home-dir /var/lib/eveland-build --create-home eveland-build
  ```
- **Platform data root**: Create the unified platform data directory (default: `/var/lib/eveland`):
  ```bash
  sudo install -d -m 0755 /var/lib/eveland
  ```

## 4. PostgreSQL planning

Eveland requires two logical databases (which may reside on the same PostgreSQL instance):

1. **Platform control plane database** (`DATABASE_URL`): Stores team credentials, project metadata, and session observations.
2. **Shared workflow database** (`EVELAND_WORKFLOW_WORLD_URL`): Backs durable timers and workflows across all platform agents (isolated by `tenant_id`).

### Deployment options

- **Bundled container**: Spin up the bundled Postgres container via Compose (listening on `127.0.0.1:17310`). Ideal for single-node setups.
- **External database**: Connect to an existing managed PostgreSQL cluster. Ensure that:
  - `postgresql-client` is installed on the host for automated backups.
  - **Do NOT place a transaction-level connection pooler (e.g. PgBouncer in transaction mode) in front of these databases**, because the durable job queue relies on session-level `LISTEN/NOTIFY` and advisory locks.

## 5. Run automated preflight verification

In the Worker checkout, run the automated verification script:

```bash
pnpm --filter @evelandhq/worker exec tsx src/integration/preflight-check.ts
```

The script verifies systemd permissions, sandbox toolchain availability, system user existence, and path permissions in one pass. Proceed only after it reports `PREFLIGHT OK`.

Continue with [Install the core services](/docs/production/core-services).

## Deeper reference

- [Production architecture overview](/docs/production): core services, host Worker, and systemd topology
- [Why bubblewrap sandboxing](/docs/reference/design/sandbox): AppArmor configuration and sandbox self-check decisions
- [Capacity planning](/docs/operations/capacity): host hardware resource estimates and Postgres connection budgets
- [Troubleshooting](/docs/reference/troubleshooting#worker-will-not-start): common preflight errors and remediation steps
