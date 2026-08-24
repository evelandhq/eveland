---
title: Verify the platform
description: Prove the complete production path with a real Eve deployment, stable request, and observed session.
---

A working login page is not proof that the runtime path works. Verify the complete system with a representative Eve project.

## Platform checks

1. Confirm API and Agent Gateway `/health` report the intended stable version and exact revision.
2. Confirm Worker is active and its production preflight passed (`journalctl -u eveland-worker`).
3. Confirm the workflow dispatcher printed `workflow-dispatcher: ready` and its registration heartbeat is fresh — production builds and workflow-step activation fail closed with `workflow_unavailable` while it is stale.
4. Sign in as the initial admin and inspect the masked component configuration under **Settings → About**; all components must agree on version, revision, and release channel.
5. Invite a second team member and confirm the invitation is single-use.

## Runtime checks

1. Import an Eve project with a supported dependency version.
2. Add the minimum required Project Secrets.
3. Build a new immutable preview. Watch the build log for the sandbox markers below.
4. Call the preview hostname through the Agent Gateway and complete a real turn.
5. Promote the healthy Deployment to the stable route.
6. Call the stable hostname and confirm the Session appears with Deployment provenance and reported usage.
7. Allow the idle window to expire, then call again and confirm on-demand activation succeeds.

## Build log markers

A healthy build on the systemd runtime logs which sandbox modules were generated, for example:

```
Injected eve sandbox modules: agent/sandbox.js
Sandbox self-check passed: the vendored bwrap backend runs under this host's deployment hardening.
```

The self-check exists because a passing HTTP health check does not by itself mean the sandbox works: Eve prewarms sandboxes lazily, so a broken bubblewrap setup would otherwise first surface as a failed agent turn long after the deploy was reported successful. Eveland instead runs the real vendored backend under deployment-equivalent hardening immediately after every build, and **fails the build** when it fails. A failure message names the exact host prerequisites to check (AppArmor profile, `/workspace`, the sandbox toolchain) — see [Prepare the host](/docs/production/prerequisites).

## Deployment logs

Each Deployment runs as a transient unit; read its journal with:

```bash
journalctl -u eveland-<project>-<deployment>.service
```

For scheduler, activation, and cold-start failures, start from **Settings → About** and the ScheduleRun detail under the Project's Sessions history — see [Troubleshooting](/docs/reference/troubleshooting).

## Integration smoke test (optional)

Before committing a production host pattern, the repository's Lima harness proves the same systemd/bwrap path end to end on a disposable Ubuntu 24.04 VM: import a fixture project, build it under bwrap, start it as a transient unit, poll health, serve a request, and tear it down — plus scheduler scale-to-zero and managed-connections fixtures.

```bash
brew install lima
bash infra/integration/run.sh
```

A fully successful run exits 0 and prints `SMOKE OK`. On failure, inspect the guest units from the host: `limactl shell eveland-test -- sudo journalctl -u 'eveland-*' --no-pager | tail -50`.

Record the exact revision and configuration used for the verification. Continue with [Deploy your first agent](/docs/agents/first-deployment) for the team-facing workflow.

## Deeper reference

- [Deploy your first agent](/docs/agents/first-deployment): onboarding guide for agent developers
- [Health and diagnostics](/docs/operations/diagnostics): component availability checks and log inspection matrix
- [Troubleshooting](/docs/reference/troubleshooting): symptom-specific triage and known platform limits
- [Security model](/docs/operations/security): full security boundaries and process privilege model
