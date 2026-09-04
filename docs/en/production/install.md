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

The installer stays deliberately small. It installs anything missing (`git`, `curl`, Docker and Compose v2, Node 24 — a private copy under the appliance root, leaving your `PATH` alone), clones the newest stable tag into `/opt/eveland/source`, adds the `eveland-ctl` and `eveland` commands to `/opt/eveland/bin`, and then hands over to `eveland-ctl start`, which does the actual install.

Run it as root. That is what makes the first boot land directly on the production form — platform processes as systemd units, Docker holding only the Collector and the optional bundled database.

## 2. Answer a few questions

The first boot asks for what only you can know:

| Question          | What to answer                                                                           |
| :---------------- | :--------------------------------------------------------------------------------------- |
| **Public origin** | The URL the platform will be reached at, e.g. `https://console.example.com`.             |
| **Admin email**   | The first administrator's login. The password is generated, never typed.                 |
| **Database**      | The bundled Postgres container (fine for a single node), or the URL of your own cluster. |
| **Model API key** | Optional. Seeds the built-in demo agent so you have something to deploy immediately.     |

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

## Coming from an older, hand-installed platform

If Eveland already runs on this host from a manual checkout and hand-written units, the installer can adopt it in place: same database, same releases, same projects. One value decides whether that works — **`APP_SECRET_KEY`**. Every project secret in the database is encrypted with it, so the old one must come across; a freshly generated key makes all of them unreadable.

**1. Back up both databases and the data directory** — see [Backup and restore](/docs/operations/backup-restore). Do not skip this.

**2. Stop the old services.**

```bash
sudo systemctl disable --now eveland-api eveland-gateway eveland-web eveland-worker eveland-workflow-dispatcher
```

**3. Move the old checkout out of the way.** The appliance wants `/opt/eveland` for itself, and your checkout is probably sitting there:

```bash
sudo mv /opt/eveland /opt/eveland-old
```

**4. Install, but do not start yet.**

```bash
curl -fsSL https://eveland.ai/install.sh -o install.sh
sudo bash install.sh --no-start
```

**5. Carry the old configuration over.** Copy the values from the old `.env` into `/opt/eveland/etc/eveland.env`, keeping the `EVELAND_NODE` line the installer just pinned there. At minimum:

```ini
EVELAND_PUBLIC_ORIGIN=https://console.example.com
EVELAND_AGENT_BASE_DOMAINS=agents.example.com
DATABASE_URL=postgres://…
EVELAND_WORKFLOW_WORLD_URL=postgres://…
EVELAND_DATA_DIR=/var/lib/eveland   # keep pointing at the existing data root
EVELAND_RUNTIME=systemd
APP_SECRET_KEY=…                    # the old one, or every stored secret is lost
BETTER_AUTH_SECRET=…                # keep it, or everyone is signed out
EVELAND_GATEWAY_SERVICE_TOKEN=…
EVELAND_GATEWAY_AFFINITY_SECRET=…
EVELAND_SCHEDULER_RUNTIME_SECRET=…
EVELAND_SCHEDULER_DISPATCH_SECRET=…
EVELAND_SCHEDULER_REDEEM_URL=http://127.0.0.1:17301/api/scheduler/redeem
WORKFLOW_DISPATCHER_ACTIVATION_API_URL=http://127.0.0.1:17301
WORKFLOW_DISPATCHER_ACTIVATION_TOKEN=…   # the same value as EVELAND_GATEWAY_SERVICE_TOKEN
EVELAND_OTLP_SERVICE_TOKEN=…
EVELAND_ADMIN_EMAIL=…
```

Keep the file at mode `0600`. A configuration that already contains `APP_SECRET_KEY` is adopted verbatim: the first boot asks nothing and generates no new secrets.

**6. Record which database this installation uses**, in `/opt/eveland/etc/install.json`:

```json
{
  "version": 1,
  "installedAt": "2026-09-04T00:00:00Z",
  "method": "manual",
  "osMode": "linux",
  "bootstrapCompleted": false,
  "database": "external"
}
```

Use `"bundled"` if Postgres is the container on `127.0.0.1:17310`, `"external"` if it is your own cluster. Without this file the ctl refuses to guess — guessing wrong is how an installation ends up running beside a second, empty database.

**7. Start it and check.**

```bash
sudo /opt/eveland/bin/eveland-ctl doctor   # missing keys, ports, database — before anything runs
sudo /opt/eveland/bin/eveland-ctl start    # adopts the config, installs the units, migrates
/opt/eveland/bin/eveland-ctl status
```

`start` rewrites `/etc/systemd/system/eveland-*.service` with the units it owns and gives them environment files under `/opt/eveland/etc/`, so the old `/etc/eveland/*.env` files stop being read. Once **Settings → About** shows every component on the new version and one existing project still builds and deploys — the real proof that `APP_SECRET_KEY` came across — delete `/etc/eveland` and `/opt/eveland-old`.

From here on, upgrades are `eveland-ctl update`.

## Installing by hand instead

The installer is the supported path, and the one we test. Install by hand only when your host rules it out — no root on `/opt`, an image you must build from a configuration-management tool, or a hardened host where each step needs review. The manual pages walk through exactly what the installer automates:

[Host prerequisites](/docs/production/prerequisites) → [Core services](/docs/production/core-services) → [Host Worker](/docs/production/worker) → [Workflow dispatcher](/docs/production/workflow-dispatcher) → [Agent traffic](/docs/production/networking) → [Verify](/docs/production/verify).

## Deeper reference

- [Production architecture](/docs/production): what the five services do and why they run as systemd units
- [eveland-ctl](/docs/reference/ctl): appliance layout, full command reference, and doctor checks
- [Upgrades and rollbacks](/docs/operations/upgrades): moving between releases safely
- [Troubleshooting](/docs/reference/troubleshooting): symptom-by-symptom triage
