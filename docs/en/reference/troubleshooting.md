---
title: Troubleshooting
description: Diagnose production installation, build, runtime, routing, activation, and observation failures.
---

Start with [Health and diagnostics](/docs/operations/diagnostics) so the failure is assigned to the correct surface.

## Worker will not start

Run standalone preflight and resolve the complete list. Common causes include a relative data directory, missing app/build users, absent `/workspace`, missing bwrap or sandbox commands, an unbuilt backend, or a missing `EVELAND_WORKFLOW_WORLD_URL`. That URL is required in production: every new build uses the shared workflow world, and the legacy `WORKFLOW_POSTGRES_URL` does not satisfy the requirement.

## A project stays pending

Confirm Worker is active, reaches the same Postgres database as API, and can resolve the stored source path through the same absolute data root. An accepted API request only means the job was queued.

## Build succeeds but health fails

Inspect the persisted deployment diagnostic and the systemd unit journal. Confirm the Agent binds its allocated loopback port and answers `/eve/v1/health`. The captured diagnostic should preserve the original failure even when cleanup also fails.

## Public Host returns 404, 502, or a cold-start timeout

Verify wildcard DNS/TLS, `EVELAND_AGENT_BASE_DOMAINS`, Traefik's `/internal` exclusion, the route target, and its RuntimeInstance. For continuations, inspect the SessionBinding rather than recalculating route weights.

## Usage is missing

Check Collector/Built-in liveness under **Settings → Instance health**, external destination probe status under **Settings → Observability**, and the Session's usage completeness. Eveland records only provider usage reported through Eve and never estimates missing values.

## Docker cannot allocate an Agent bridge network

Each active Docker Deployment consumes one bridge subnet, and Docker's built-in address pools are too small for a long-lived multi-Deployment host. When the Worker's Docker-runtime preflight or a deployment fails with an address-pool error ("all predefined address pools are subnetted"), configure a non-overlapping pool and restart Docker:

```json
{
  "default-address-pools": [{ "base": "10.201.0.0/16", "size": 24 }]
}
```

Merge this into `/etc/docker/daemon.json`, choosing a base that does not overlap the host, VPN, or deployment networks. The example permits 256 bridge networks. The Docker-runtime startup preflight creates and removes one temporary bridge so address-pool exhaustion is reported before any deployment job is accepted.

## Schedule did not run

Inspect ScheduleVersion, ScheduleRun, pinned target, Worker planner/dispatcher logs, prewarm configuration, and activation state. Do not enable Eve's native cron path in a prepared Release.

Start in authenticated **Settings → About**: confirm API shows `EVELAND_ACTIVATION_LEASE_TTL_MS` and `EVELAND_COLD_START_TIMEOUT_MS`, Agent Gateway shows `EVELAND_API_INTERNAL_URL` and `EVELAND_ACTIVATION_RENEW_INTERVAL_MS`, and Worker shows the idle/recovery/reconciliation values and `EVELAND_SCHEDULER_PREWARM_MS`.

For a cron or manual failure, open the ScheduleRun detail under the Project's Sessions history. It records status, attempt, missed ticks, the exact Release/Deployment/ScheduleVersion, timings, a sanitized error, aggregate provider usage, and zero or more linked Sessions. `failed` before dispatch has zero fabricated Sessions. `dispatch_unknown` means the credential was redeemed but the result was lost, so Eveland deliberately does not replay the authored side effect automatically. Use the run ID to correlate the Project Runtime log and `journalctl -u eveland-<project>-<deployment>.service`; never paste decrypted Project Secrets, scheduler credentials, affinity cookies, or raw env files into the UI or logs.

A dispatch that returns Session IDs remains `running` until Built-in projects a root turn boundary for every returned Session; its schedule lease protects the exact RuntimeInstance beyond the normal idle TTL. If that RuntimeInstance disappears, reconciliation records `platform.runtime_lost` and fails the affected Session and ScheduleRun; if no boundary arrives before `EVELAND_SCHEDULE_RUN_MAX_RUNTIME_MS`, it records `platform.runtime_deadline_exceeded` instead. A short `draining` transition is retried before dispatch and should not appear as a terminal ScheduleRun failure.

## Cold start fails or hangs

Compare the Deployment and its latest RuntimeInstance: `starting` should have one coalesced `ensure_deployment_running` job, `failed` retains `lastError`, and `stopped` is a normal dormant state. Check API/Agent Gateway service-token agreement and reachability of `EVELAND_API_INTERNAL_URL`, then inspect the owning runtime (`systemctl status` / `journalctl` for systemd). A client abort releases only that request's lease; other active leases must remain.

## Known limits

- Eveland does not automatically prune the sandbox cache under `EVELAND_SANDBOX_CACHE_DIR`; disk usage grows with the number of durable sessions and unique templates. The backend's explicit dry-run/list/prune API is available to an operator.
- Each active Docker Deployment uses one bridge subnet. Capacity is bounded by Docker's configured `default-address-pools`; the recommended `/16` split into `/24` networks permits 256 concurrent managed networks, including other Docker bridges on the same daemon.
- An eve project with no `agent/` directory, or a plain Node project, gets no injected sandbox and runs on eve's default sandbox chain. Under production-style `eve start`, the optional `just-bash` peer may be absent; even when installed it cannot run real Node or TypeScript binaries.
- systemd Deployment processes use `systemd-run --collect` transient units and therefore do not restart automatically after a host reboot. The enabled Worker does restart, reconciles stale `ready` RuntimeInstances to `stopped`/`failed`, and the next cron or Agent Gateway request cold-starts the preserved exact Release. The immutable Deployment, routes, history, and SessionBindings survive; only the transient process is absent during the cold interval.
