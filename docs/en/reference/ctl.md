---
title: eveland-ctl operational tool
description: "Host platform management CLI: installation script, appliance layout, lifecycle controls, and environment doctor checks."
---

`eveland-ctl` is the management and operations CLI for the platform host, responsible for supervising core processes, checking host health, streaming service logs, and automating version upgrades.

---

## 1. Installation

`eveland-ctl` arrives with the platform itself:

```bash
curl -fsSL https://eveland.ai/install.sh | sudo bash
```

The installer prepares the host and hands off to `eveland-ctl start`, which performs the install. [Install Eveland](/docs/production/install) is the walkthrough; this page is the command reference.

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

| Command                         | Operational Behavior                                                                                                                                                                                           |
| :------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eveland-ctl start`             | Boots infrastructure containers (OTel Collector, bundled Postgres), then launches core platform processes. Supports `--foreground` and `--skip-infra`.                                                         |
| `eveland-ctl stop`              | Gracefully terminates platform services (stopping systemd units in reverse order). Leaves infrastructure containers running.                                                                                   |
| `eveland-ctl restart`           | Sequentially executes `stop` followed by `start`.                                                                                                                                                              |
| `eveland-ctl status`            | Reports the release on disk (and any newer one), then inspects process liveness, HTTP health endpoints, and database connectivity. Exits 0 when fully healthy — a pending upgrade never changes the exit code. |
| `eveland-ctl logs [process]`    | Streams logs for platform components. Supports `-f` (follow) and `--tail N`.                                                                                                                                   |
| `eveland-ctl doctor`            | Runs comprehensive host diagnostics (sandboxing permissions, port availability, database connectivity). Reports all failures in one pass.                                                                      |
| `eveland-ctl update`            | Creates database backups, fetches the latest stable release, executes migrations, and performs rolling restarts. Supports `--version vX.Y.Z`.                                                                  |
| `eveland-ctl install --systemd` | Renders and registers systemd unit files for all core platform services.                                                                                                                                       |

### Colored output

`status` and `doctor` color their reports so the rows that are _not_ healthy are the ones that stand out: a green `✓` or `[  ok  ]` with dimmed details, yellow for anything the tool could not answer, red for a failure. Color is written only when stdout is a terminal, so a redirect, a pipe into `grep`, or a report pasted into an issue stays plain text. `NO_COLOR=1` turns it off on a terminal; `FORCE_COLOR=1` turns it on when it is not one (piping into `less -R`, for example).

---

## 4. Environment doctor checks

`eveland-ctl doctor` executes exhaustive host verification, checking:

- **Prerequisites**: Node.js, pnpm, Docker/Compose, `unzip`, and bubblewrap sandboxing utilities.
- **Environment variables**: Validates `eveland.env` required keys, flagging development fallback secrets in production.
- **Port conflicts**: Verifies that platform ports (`17300`–`17314`) are not held by extraneous processes, ensuring database ports are restricted to loopback.
- **Database consistency**: Tests `DATABASE_URL` connectivity and inspects schema migration history.

## Deeper reference

- [Install Eveland](/docs/production/install): the installed path, start to finish
- [Host prerequisites](/docs/production/prerequisites): what the ctl provisions, if you do it by hand
- [Upgrades and rollbacks](/docs/operations/upgrades): version upgrade and maintenance workflows
