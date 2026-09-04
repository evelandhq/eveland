---
title: Troubleshooting reference
description: Quick diagnostic and remediation guide for common production deployment, routing, cold-start, schedule, and telemetry failures.
---

This guide is organized by observed symptom. Before troubleshooting, inspect overall platform liveness under **Settings → Instance health** in the dashboard.

---

## 1. Worker fails to start

### Common causes

- Missing host dependencies (e.g. `bubblewrap`, `apparmor`, or unprivileged `bwrap` user namespace permissions);
- Absent `/workspace` mount point or missing `eveland-app` / `eveland-build` system users;
- Unset `EVELAND_WORKFLOW_WORLD_URL` or inability to connect to PostgreSQL.

### Remediation steps

1. Inspect Worker systemd logs:
   ```bash
   sudo journalctl -u eveland-worker -n 50 --no-pager
   ```
2. Run the automated preflight verification script and address reported errors:
   ```bash
   pnpm --filter @evelandhq/worker exec tsx src/integration/preflight-check.ts
   ```

---

## 2. Project import stays in "Pending" status

### Common causes

- Worker process is inactive or failed;
- Worker and API connect to different databases or point to mismatched `EVELAND_DATA_DIR` roots.

### Remediation steps

1. Verify the Worker service is active:
   ```bash
   sudo systemctl status eveland-worker
   ```
2. Confirm that `DATABASE_URL` and `EVELAND_DATA_DIR` match exactly between API and Worker configuration files.

---

## 3. Build succeeds but health check times out

### Common causes

- Agent code fails to bind to the dynamically assigned port;
- Agent crashes on startup or hangs during initialization;
- Post-build sandbox self-check failed.

### Remediation steps

1. Inspect deployment runtime logs:
   ```bash
   sudo journalctl -u eveland-<projectSlug>-<deploymentId>.service -n 100 --no-pager
   ```
2. Confirm that the process responds to `GET http://127.0.0.1:<port>/eve/v1/health`.

---

## 4. Public host returns 502 Bad Gateway or cold-start timeout

### Common causes

- Agent Gateway service is inactive or port `17300` is blocked;
- Reverse proxy (Traefik) misconfigured;
- Agent cold start exceeded the configured readiness timeout (default: 30 seconds).

### Remediation steps

1. Verify Agent Gateway status and health:
   ```bash
   sudo systemctl status eveland-gateway
   curl -I http://127.0.0.1:17300/health
   ```
2. Inspect deployment event logs in the dashboard to determine if model loading or dependency imports caused cold-start delays. Increase `EVELAND_COLD_START_TIMEOUT_MS` if necessary.

---

## 5. Token usage or conversation events are missing

### Common causes

- Managed OTel Collector container is offline or unreachable;
- Model provider omitted `step.completed.data.usage` in the response stream.

### Remediation steps

1. Check OTel Collector container logs:
   ```bash
   docker compose logs otel-collector
   ```
2. Check exporter connectivity in **Settings → Observability**. Eveland records real reported token usage and never estimates missing values.

---

## 6. Scheduled tasks (Schedules) do not run

### Common causes

- Workflow Dispatcher is stopped or unable to acquire its advisory lock;
- Non-standard cron syntax (Eveland strictly requires 5-field minute-resolution UTC cron).

### Remediation steps

1. Check Dispatcher status and heartbeats:
   ```bash
   sudo systemctl status eveland-workflow-dispatcher
   sudo journalctl -u eveland-workflow-dispatcher -n 50 --no-pager
   ```
2. Open **Sessions** history for the project, inspect the **ScheduleRun** entry, and review missed ticks or error traces.

## Deeper reference

- [Health and diagnostics](/docs/operations/diagnostics): availability monitoring and triage matrix
- [Runtime and resources](/docs/operations/runtime): lifecycle management and orphan recovery
- [Environment variables](/docs/reference/environment-variables): platform-wide configuration reference
