---
title: Install Eveland
description: Install a production Eveland host with one command, using the official installer and eveland-ctl.
---

One command installs Eveland. It prepares the host, checks out the newest stable release, generates every secret, applies migrations, and leaves the platform running as systemd services that come back with the machine.

## Before you start

- **A Linux server with systemd**, and root on it (Ubuntu 24.04 LTS is what we test). Start with 4 vCPU and 8 GB RAM; see [capacity planning](/docs/operations/capacity) to size it properly.
- **A domain you control**, for the console (`console.example.com`) and for agents (a wildcard `*.agents.example.com`). DNS is not needed to install — you can point it later.

Everything else — Node, pnpm, Docker, the sandbox toolchain, service users — the installer handles.

_macOS is supported for trying Eveland on a laptop — run the same command without `sudo` and it installs into `~/.eveland`. Production is Linux._

## 1. Run the installer

```bash
curl -fsSL https://eveland.ai/install.sh | sudo bash
```

To read the script before running it, download it and check it against the published checksum:

```bash
curl -fsSL https://eveland.ai/install.sh -O
curl -fsSL https://eveland.ai/install.sh.sha256 | sha256sum -c -
less install.sh && sudo bash install.sh
```

The installer stays deliberately small. It installs anything missing (`git`, `curl`, Docker and Compose v2, Node 26 — a private copy under the appliance root, leaving your `PATH` alone), clones the newest stable tag into `/opt/eveland/source`, adds the `eveland-ctl` and `eveland` commands to `/opt/eveland/bin`, and then hands over to `eveland-ctl start`, which does the actual install.

Run it as root. That is what makes the first boot land directly on the production form — platform processes as systemd units, Docker holding only the Collector and the optional bundled database.

## 2. Answer a few questions

The first boot asks for what only you can know:

| Question          | What to answer                                                                           |
| :---------------- | :--------------------------------------------------------------------------------------- |
| **Public origin** | The URL the platform will be reached at, e.g. `https://console.example.com`.             |
| **Admin email**   | The first administrator's login. The password is generated, never typed.                 |
| **Database**      | The bundled Postgres container (fine for a single node), or the URL of your own cluster. |
| **Model API key** | Optional. Seeds the built-in demo agent so you have something to deploy immediately.     |

An external cluster must give the platform session-level connections: do not put a transaction-level pooler (PgBouncer in transaction mode, for example) in front of it, because the job queue relies on `LISTEN/NOTIFY` and advisory locks. The installer creates the shared workflow database next to the platform's own on the same server.

Everything else is generated for you and written to `/opt/eveland/etc/eveland.env` (mode `0600`) — auth secrets, service tokens, and the admin password:

```bash
sudo grep EVELAND_ADMIN_PASSWORD /opt/eveland/etc/eveland.env
```

From there the installer runs unattended: it provisions the host (sandbox toolchain, the bubblewrap AppArmor profile, `/workspace`, the `eveland-app` and `eveland-build` users), starts the Collector and the bundled database in Docker, applies migrations, builds the dashboard, and registers and starts the systemd units. When it prints `Eveland is running at …`, you are done installing.

Add `/opt/eveland/bin` to your `PATH` when prompted, or call the commands by full path.

## 3. Check it

```bash
eveland-ctl status    # processes, health endpoints, database connectivity
eveland-ctl doctor    # everything a healthy host needs, all failures in one pass
```

Then sign in at your public origin as the admin, and continue with:

- [Configure agent traffic](/docs/production/networking) — wildcard DNS, TLS, and the reverse proxy in front of the gateway.
- [Verify the installation](/docs/production/verify) — prove the whole path end to end with a real project.

## Day-two commands

| Command               | What it does                                                                   |
| :-------------------- | :----------------------------------------------------------------------------- |
| `eveland-ctl status`  | Process view plus live health and database probes. Exits 0 when fully healthy. |
| `eveland-ctl logs -f` | Follows the platform processes' logs.                                          |
| `eveland-ctl restart` | Stops and starts the platform.                                                 |
| `eveland-ctl doctor`  | Full host diagnosis: toolchain, configuration, ports, database.                |
| `eveland-ctl update`  | Backs up the databases, moves to the newest release, migrates, restarts.       |

Re-running the installer on a machine that already has Eveland is an upgrade — it forwards to `eveland-ctl update`. The full command reference is in [eveland-ctl](/docs/reference/ctl).

## Deeper reference

- [Production architecture](/docs/production): what the five services do and why they run as systemd units
- [eveland-ctl](/docs/reference/ctl): appliance layout, full command reference, and doctor checks
- [Upgrades and rollbacks](/docs/operations/upgrades): moving between releases safely
- [Troubleshooting](/docs/reference/troubleshooting): symptom-by-symptom triage
