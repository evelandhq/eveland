---
title: Verify production deployment
description: Prove the complete end-to-end production path with project import, preview validation, stable promotion, and session tracking.
---

A loading dashboard console does not guarantee that the underlying runtime orchestrator is fully operational. Validate the end-to-end platform using a representative Eve project.

## 1. Core health checks

```bash
eveland-ctl status    # processes, health endpoints, database
eveland-ctl doctor    # host, configuration, ports
```

That covers the first three checks below in one pass. The equivalents by hand:

1. **API and Gateway health**:
   Query `http://127.0.0.1:17301/health` and `http://127.0.0.1:17300/health`, verifying that both return `status: ok` with matching release versions.
2. **Worker preflight**:
   Inspect `journalctl -u eveland-worker` to confirm that all host preflight checks passed.
3. **Workflow Dispatcher**:
   Inspect `journalctl -u eveland-workflow-dispatcher` to confirm it logged `workflow-dispatcher: ready`.
4. **Dashboard component alignment**:
   Sign in as the initial administrator, navigate to **Settings → About**, and verify that API, Dashboard, Worker, and Dispatcher report identical `version`, `revision`, and `channel` properties.

## 2. End-to-end runtime validation

Walk through a complete delivery cycle with a sample project:

1. **Import project**: Create a Project in the console from a supported Eve Git repository or Zip archive.
2. **Configure secrets**: Add any required model provider keys (e.g. `OPENAI_API_KEY`).
3. **Build and deploy preview**:
   - Trigger **Build & Deploy**; confirm in the build log that dependencies installed inside the bubblewrap sandbox and that the step logs `Sandbox self-check passed`;
   - Confirm the preview deployment transitions to `healthy`.
4. **Test interaction and streaming**:
   - Open the [Playground](/docs/reference/playground) or query the preview hostname directly;
   - Verify prompt execution, tool calls, and streaming NDJSON chunks.
5. **Promote to production**:
   - Click **Promote** to atomically redirect stable traffic to the verified deployment;
   - Query the stable hostname and verify correct response generation.
6. **Telemetry and session tracking**:
   - Open the **Sessions** view; confirm the dialogue turn, deployment provenance, and model token usage were projected into Postgres.
7. **Verify scale-to-zero**:
   - Allow the idle window to elapse (default: 5 minutes) and observe the deployment status change to `stopped`;
   - Send another request to confirm that the gateway triggers a sub-second cold start and serves the request seamlessly.

## 3. Useful diagnostic commands

If an issue arises during validation, inspect unit logs:

```bash
# Worker scheduling and build logs
sudo journalctl -u eveland-worker -f

# Workflow Dispatcher timer logs
sudo journalctl -u eveland-workflow-dispatcher -f

# Specific agent deployment runtime journal
sudo journalctl -u eveland-<projectSlug>-<deploymentId>.service -f
```

_(Optional) On macOS workstations, run the automated integration smoke test via Lima: `bash infra/integration/run.sh`._

Your production installation is now verified! Proceed to [Deploy your first agent](/docs/agents/first-deployment) to onboard your team.

## Deeper reference

- [Deploy your first agent](/docs/agents/first-deployment): onboarding guide for agent developers
- [Health and diagnostics](/docs/operations/diagnostics): component availability checks and log inspection matrix
- [Troubleshooting](/docs/reference/troubleshooting): symptom-specific triage and known platform limits
- [Security model](/docs/operations/security): full security boundaries and process privilege model
