---
title: eveland-ctl operational tool
description: "Host platform management CLI: installation script, appliance layout, lifecycle controls, and environment doctor checks."
---

`eveland-ctl` is the management and operations CLI for the platform host, responsible for supervising core processes, checking host health, streaming service logs, and automating version upgrades.

---

## 1. Automated installation

On Linux hosts, prepare the runtime and clone the repository with one command:

```bash
curl -fsSL https://eveland.ai/install.sh | bash
```

- **Installer behavior**: Detects operating system and architecture, verifies or installs Node.js 24 and pnpm, and clones the latest stable Eveland release into `/opt/eveland`.
- **System preparation**: Automatically installs missing system tools (`git`, `curl`, Docker/Compose v2) on Ubuntu systems before handing execution off to `eveland-ctl start`.

---

## 2. Host appliance layout

The `EVELAND_HOME` environment variable specifies the appliance root directory (`/opt/eveland` on Linux, `~/.eveland` on macOS):

| Directory / File   | Responsibility and Contents                                                                                       |
| :----------------- | :---------------------------------------------------------------------------------------------------------------- |
| `source/`          | Platform source checkout, tracking the current release tag. Replaced during upgrades.                             |
| `etc/eveland.env`  | Global environment configuration; single source of truth for platform services.                                   |
| `etc/install.json` | Metadata recording installation mode, dates, and database configuration.                                          |
| `data/`            | Platform persistent data root (`EVELAND_DATA_DIR`), holding release builds, source checkouts, and sandbox caches. |
| `logs/`            | Standard output and error logs from installation and supervised services.                                         |
| `backups/`         | Database snapshots created automatically before each version upgrade.                                             |

---

## 3. Command reference

| Command                         | Operational Behavior                                                                                                                                   |
| :------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eveland-ctl start`             | Boots infrastructure containers (OTel Collector, bundled Postgres), then launches core platform processes. Supports `--foreground` and `--skip-infra`. |
| `eveland-ctl stop`              | Gracefully terminates platform services (stopping systemd units in reverse order). Leaves infrastructure containers running.                           |
| `eveland-ctl restart`           | Sequentially executes `stop` followed by `start`.                                                                                                      |
| `eveland-ctl status`            | Inspects process liveness, queries HTTP health endpoints, and checks database connectivity. Exits 0 when fully healthy.                                |
| `eveland-ctl logs [process]`    | Streams logs for platform components. Supports `-f` (follow) and `--tail N`.                                                                           |
| `eveland-ctl doctor`            | Runs comprehensive host diagnostics (sandboxing permissions, port availability, database connectivity). Reports all failures in one pass.              |
| `eveland-ctl update`            | Creates database backups, fetches the latest stable release, executes migrations, and performs rolling restarts. Supports `--version vX.Y.Z`.          |
| `eveland-ctl install --systemd` | Renders and registers systemd unit files for all core platform services.                                                                               |

---

## 4. Environment doctor checks

`eveland-ctl doctor` executes exhaustive host verification, checking:

- **Prerequisites**: Node.js, pnpm, Docker/Compose, `unzip`, and bubblewrap sandboxing utilities.
- **Environment variables**: Validates `eveland.env` required keys, flagging development fallback secrets in production.
- **Port conflicts**: Verifies that platform ports (`17300`–`17314`) are not held by extraneous processes, ensuring database ports are restricted to loopback.
- **Database consistency**: Tests `DATABASE_URL` connectivity and inspects schema migration history.

## Deeper reference

- [Host prerequisites](/docs/production/prerequisites): toolchain and sandboxing setup
- [Install core services](/docs/production/core-services): systemd service configuration
- [Upgrades and rollbacks](/docs/operations/upgrades): version upgrade and maintenance workflows
