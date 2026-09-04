---
title: Install the host Worker
description: Install the privileged Worker as a host systemd service to manage sandboxed builds and agent process lifecycles.
---

The Worker is Eveland's sole host-native Runtime Controller. To maintain strict security isolation, it operates exclusively on the host with no public network listeners.

## 1. Prepare codebase

The Worker runs from `/opt/eveland` on the host, checked out to the matching stable release tag:

```bash
cd /opt/eveland
git fetch --tags origin
git checkout vX.Y.Z
pnpm install --frozen-lockfile
```

_Note: The `@evelandhq/sandbox-bwrap` sandbox backend is published prebuilt and pinned by the lockfile; no separate compilation is needed._

## 2. Install and start systemd service

```bash
sudo install -d -m 0750 /etc/eveland
sudo cp infra/systemd/eveland-worker.env.example /etc/eveland/eveland-worker.env
sudo cp infra/systemd/eveland-worker.service /etc/systemd/system/
```

Configure the environment file before starting the service, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eveland-worker
```

## 3. Configure Worker environment

In `/etc/eveland/eveland-worker.env`, ensure the following values match your core services:

```ini
# Runtime and environment
EVELAND_RUNTIME=systemd
NODE_ENV=production

# Platform data directory (must exactly match API mount path)
EVELAND_DATA_DIR=/var/lib/eveland

# Database connections
DATABASE_URL=postgres://eveland:password@127.0.0.1:17310/eveland
EVELAND_WORKFLOW_WORLD_URL=postgres://eveland:password@127.0.0.1:17310/eveland

# Internal service authentication (must match core services)
APP_SECRET_KEY=your_app_encryption_key_32_bytes
EVELAND_GATEWAY_SERVICE_TOKEN=your_gateway_service_token
EVELAND_GATEWAY_INTERNAL_URL=http://127.0.0.1:17300
EVELAND_SCHEDULER_RUNTIME_SECRET=your_scheduler_runtime_secret
EVELAND_SCHEDULER_DISPATCH_SECRET=your_scheduler_dispatch_secret
EVELAND_SCHEDULER_REDEEM_URL=http://127.0.0.1:17301/api/scheduler/redeem
EVELAND_IDENTITY_ISSUER=https://console.example.com
EVELAND_IDENTITY_JWKS_URL=http://127.0.0.1:17301/.well-known/jwks.json

# Telemetry and release identity
EVELAND_AGENT_BASE_DOMAINS=agents.example.com
EVELAND_OTLP_SERVICE_TOKEN=your_otlp_service_token
EVELAND_RELEASE_CHANNEL=stable
EVELAND_REVISION=your_git_commit_sha
```

## 4. Build and execution isolation boundaries

### Sandboxed dependency builds

- When running dependency installations (`npm ci`/`pnpm install`) and bundle compilation (`npx eve build`), Worker executes scripts inside an unprivileged **bubblewrap sandbox** under the `eveland-build` system user.
- **Secret shielding**: Worker's own sensitive environment variables (`DATABASE_URL`, `APP_SECRET_KEY`) are stripped before invoking build processes, preventing leakage to build scripts.
- **Variable filtering**: Only non-sensitive project configuration (`variable`) is exposed during build to generate manifests. Sensitive credentials (`secret`) are only injected into active deployment processes.

### Runtime process isolation

- **Ephemeral DynamicUser**: Each deployed agent executes under an isolated systemd `DynamicUser`, binding exclusively to a private loopback port (`127.0.0.1:18000–18999`).
- **Protected secret files**: Runtime environment variables are materialized as root-owned, mode `0600` files read by systemd, keeping agent environments strictly separated.

## 5. Verify Worker operation

Inspect Worker journal logs to confirm preflight validation succeeds:

```bash
sudo journalctl -u eveland-worker -f
```

A healthy Worker outputs its configuration snapshot and starts polling for platform jobs.

Next: [Install the workflow dispatcher](/docs/production/workflow-dispatcher).

## Deeper reference

- [Why systemd, not Docker](/docs/reference/design/runtime): runtime selection and host density rationale
- [Why a bubblewrap sandbox](/docs/reference/design/sandbox): build and execution sandbox isolation
- [Capacity planning](/docs/operations/capacity): calculating concurrent builds, running agents, and database connection limits
