---
title: Health and diagnostics
description: Diagnose platform service availability, triage failure surfaces, and verify sandbox self-checks.
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

| Symptom                                 | Primary Inspection Entrypoint       | Key Action                                                                            |
| :-------------------------------------- | :---------------------------------- | :------------------------------------------------------------------------------------ |
| **Import failure / Preflight error**    | Dashboard Import Job log            | Verify Git credentials, archive layout, and lockfiles.                                |
| **Dependency install / Build error**    | Dashboard Build log                 | Check `pnpm/npm` lockfiles, Eve version compatibility, and env conflicts.             |
| **Deployment startup / Health timeout** | Deployment diagnostic & systemd log | Check private port availability, env file permissions, and `/eve/v1/health` response. |
| **Agent runtime error / Crash**         | Host systemd journal                | Inspect uncaught exceptions and cgroup resource limits.                               |
| **Model failure / Missing tokens**      | Dashboard Sessions timeline         | Verify model provider keys, OTel Collector health, and network connectivity.          |
| **Gateway 502 / Host resolution**       | Agent Gateway reverse proxy logs    | Verify wildcard DNS records, TLS certificates, and target deployment health.          |
| **Workflow run never finishes**         | `eveland-ctl dead-letters`          | Fix the Deployment the letters name, then `--resolve` to replay the runs it holds.    |

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
  Sandbox self-check passed: the vendored bwrap backend runs under this host's deployment hardening.
  ```
- **If the self-check fails (halting the build)**, check these host prerequisites in order:
  1. Ensure `/etc/apparmor.d/bwrap` exists and grants `userns` permissions;
  2. Ensure the `/workspace` mount directory exists on the host;
  3. Ensure the complete toolchain (`bwrap`, `rg`, GNU `grep`, etc.) is installed on `PATH`.

Next: For specific error codes and symptoms, consult the [Troubleshooting reference](/docs/reference/troubleshooting).

## Deeper reference

- [Troubleshooting reference](/docs/reference/troubleshooting): symptom-indexed triage for concrete failures
- [Runtime and resources](/docs/operations/runtime): instance lifecycle and resource limits
- [Sandbox design decisions](/docs/reference/design/sandbox): bubblewrap hardening and self-check design
