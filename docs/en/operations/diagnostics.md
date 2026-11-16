---
title: Health and diagnostics
description: Diagnose platform service availability, triage failure surfaces, verify sandbox self-checks, and troubleshoot common failures by symptom.
---

Eveland clearly separates **component availability (Health)**, **asynchronous job logs (Job Logs)**, **runtime process output (Runtime Output)**, and **session traces (Session Events)**, helping operators quickly locate root causes.

---

## 1. Component health monitoring

- **Public liveness probes**: API and Gateway expose public `/health` endpoints returning platform version, git revision, and release channel.
- **Heartbeat registration**: Worker and Workflow Dispatcher continuously report heartbeats to the control plane API.
- **Instance health dashboard (Settings → Instance health)**:
  - Displays host CPU, memory footprint, disk usage, and trend projections;
  - Monitors concurrent queued and active builds (`Running builds N/cap`);
  - Tracks durable workflow dead letters and quarantined run queues.

---

## 2. Failure triage matrix

When diagnosing anomalies, identify the appropriate diagnostic stream:

| Symptom                                        | Primary Inspection Entrypoint       | Key Action                                                                                                                         |
| :--------------------------------------------- | :---------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| **Import failure / Preflight error**           | Dashboard Import Job log            | Verify Git credentials, archive layout, and lockfiles.                                                                             |
| **Dependency install / Build error**           | Dashboard Build log                 | Check `pnpm/npm` lockfiles, Eve version compatibility, and env conflicts.                                                          |
| **Deployment startup / Health timeout**        | Deployment diagnostic & systemd log | Check private port availability, env file permissions, and `/eve/v1/health` response.                                              |
| **Agent runtime error / Crash**                | Host systemd journal                | Inspect uncaught exceptions and cgroup resource limits.                                                                            |
| **Model failure / Missing tokens**             | Dashboard Sessions timeline         | Verify model provider keys, OTel Collector health, and network connectivity.                                                       |
| **Gateway 502 / Host resolution**              | Agent Gateway reverse proxy logs    | Verify wildcard DNS records, TLS certificates, and target deployment health.                                                       |
| **Workflow run never finishes**                | `eveland-ctl dead-letters`          | Fix the Deployment the letters name, then `--resolve` to replay the runs it holds.                                                 |
| **Dispatcher not claiming after a host crash** | `eveland-ctl dispatcher-lock`       | A dead session may still hold the ownership lock; `--terminate` evicts it, then `systemctl reset-failed` and start the dispatcher. |

---

## 3. Inspecting agent deployment runtime journals

Each agent deployment runs on the host as an independent transient systemd unit. Stream its stdout and stderr in real time:

```bash
# Stream live logs for a specific agent deployment
sudo journalctl -u eveland-<projectSlug>-<deploymentId>.service -f
```

---

## 4. Sandbox self-checks in build logs

During release compilation, Eveland injects the lightweight sandbox and immediately executes a runtime self-check under hardened permissions:

- **Passing check marker**:
  ```text
  Sandbox self-check passed: the vendored bwrap provider runs under this host's deployment hardening.
  ```
- **If the self-check fails (halting the build)**, check these host prerequisites in order:
  1. Ensure `/etc/apparmor.d/bwrap` exists and grants `userns` permissions;
  2. Ensure the `/workspace` mount directory exists on the host;
  3. Ensure the complete toolchain (`bwrap`, `rg`, GNU `grep`, etc.) is installed on `PATH`.

---

## 5. Troubleshooting by symptom

Start from **Settings → Instance health**, then find the symptom below.

### 5.1 Worker fails to start

**Common causes**

- Missing host dependencies (e.g. `bubblewrap`, `apparmor`, or unprivileged `bwrap` user namespace permissions);
- Absent `/workspace` mount point or missing `eveland-app` / `eveland-build` system users;
- Unset `WORKFLOW_WORLD_URL` or inability to connect to PostgreSQL.

**Remediation**

1. Inspect Worker systemd logs:
   ```bash
   sudo journalctl -u eveland-worker -n 50 --no-pager
   ```
2. Run the host checks and address what they report:
   ```bash
   eveland-ctl doctor
   ```

### 5.2 Project import stays in "Pending" status

**Common causes**

- Worker process is inactive or failed;
- Worker and API connect to different databases or point to mismatched `EVELAND_DATA_DIR` roots.

**Remediation**

1. Verify the Worker service is active:
   ```bash
   sudo systemctl status eveland-worker
   ```
2. Confirm that `DATABASE_URL` and `EVELAND_DATA_DIR` match exactly between API and Worker configuration files.

### 5.3 Build succeeds but health check times out

**Common causes**

- Agent code fails to bind to the dynamically assigned port;
- Agent crashes on startup or hangs during initialization;
- Post-build sandbox self-check failed.

**Remediation**

1. Inspect deployment runtime logs:
   ```bash
   sudo journalctl -u eveland-<projectSlug>-<deploymentId>.service -n 100 --no-pager
   ```
2. Confirm that `GET http://127.0.0.1:<port>/eve/v1/health` returns HTTP 200 with `{ "ok": true }`. Any other answer keeps the Deployment from becoming ready. A 404 usually means an authored `agent/channels/eve.ts` replaced the eve channel with `defineChannel(...)`, which drops the health route; use `eveChannel(...)` to keep it.

### 5.4 Public host returns 502 Bad Gateway or cold-start timeout

**Common causes**

- Agent Gateway service is inactive or port `17300` is blocked;
- Reverse proxy (Traefik) misconfigured;
- Agent cold start exceeded the configured readiness timeout (default: 30 seconds).

**Remediation**

1. Verify Agent Gateway status and health:
   ```bash
   sudo systemctl status eveland-gateway
   curl -I http://127.0.0.1:17300/health
   ```
2. Inspect deployment event logs in the dashboard to determine if model loading or dependency imports caused cold-start delays. Increase `EVELAND_COLD_START_TIMEOUT_MS` if necessary.

### 5.5 Token usage or conversation events are missing

**Common causes**

- Managed OTel Collector container is offline or unreachable;
- Model provider omitted usage in the response stream (a model run with no `usage.recorded`).

**Remediation**

1. Check OTel Collector container logs:
   ```bash
   docker compose logs otel-collector
   ```
2. Check exporter connectivity in **Settings → Observability**. Eveland records real reported token usage and never estimates missing values.

### 5.6 Scheduled tasks (Schedules) do not run

**Common causes**

- Workflow Dispatcher is stopped or unable to acquire its advisory lock;
- Non-standard cron syntax (Eveland requires 5-field minute-resolution cron, read in UTC unless the schedule sets an IANA `timezone`).

**Remediation**

1. Check Dispatcher status and heartbeats:
   ```bash
   sudo systemctl status eveland-workflow-dispatcher
   sudo journalctl -u eveland-workflow-dispatcher -n 50 --no-pager
   ```
2. Open **Sessions** history for the project, inspect the **ScheduleRun** entry, and review missed ticks or error traces.

## Deeper reference

- [Runtime and resources](/docs/operations/runtime): instance lifecycle and resource limits
- [Sandbox design decisions](/docs/reference/design/sandbox): bubblewrap hardening and self-check design
