---
title: Health and diagnostics
description: Find failures in the component, job, runtime, or session surface that owns them.
---

Start with the state that actually failed. Eveland keeps component health, asynchronous job logs, runtime output, and session events separate so one noisy stream does not become the only debugging interface.

## Component health

- API and Agent Gateway public `/health` report product version, revision, channel, and component.
- Worker reports startup identity and writes an already-masked configuration snapshot.
- Built-in OTLP receive health is separate from core-service health; Collector exporter queues retry independently.
- **Settings → About** compares Dashboard and API identity and shows allowlisted masked configuration to admins.
- **Settings → Instance health** uses a continuous Worker heartbeat, a live Agent Gateway probe, and Postgres queries to show component availability plus Worker-host CPU, memory, data-filesystem, and workload trends. An old Worker configuration snapshot is never treated as liveness evidence.
- When a shared workflow world is configured, Instance health also counts its dispatch backlog: unresolved dead letters (dispatches the platform has dropped) and quarantined runs (pending or running rows an unresolved dead letter prevents boot recovery from ever replaying). Anything above zero is a warning that awaits operator resolution; a world that cannot be read reports unavailable instead of zeros.

Instance Health stores one host sample per minute by default and provides 24-hour and 7-day views. Disk exhaustion is forecast only after at least one day of measurable growth; insufficient history stays explicit. A host that has completely lost power cannot report its own failure, so external monitoring should still poll the public API and Agent Gateway `/health` endpoints.

## Choose the right evidence

| Failure                               | Start here                                                     |
| ------------------------------------- | -------------------------------------------------------------- |
| Import or source validation           | Import job and Source Preflight log                            |
| Dependency install or `eve build`     | Build log                                                      |
| Unit startup or health timeout        | Deploy diagnostic and systemd journal                          |
| Agent process output                  | Runtime stdout/stderr                                          |
| Model, tool, subagent, or usage issue | Session timeline                                               |
| Stable or preview Host failure        | Agent Gateway health, route policy, and target RuntimeInstance |

Initial health failures capture bounded recent unit state and journal output before cleanup. Project Secret values are masked, and a diagnostic or cleanup failure never replaces the original deployment error.

Runtime output for one systemd Deployment lives in its transient unit's journal:

```bash
journalctl -u eveland-<project>-<deployment>.service
```

## Sandbox evidence in the build log

Release preparation injects the bwrap exec sandbox into every deployed Eve project, and the build log always says what happened — never silently:

```
Injected eve sandbox modules: agent/sandbox.js
```

Two variants replace or accompany that line:

- A project that shipped its own sandbox definition logs `Preserved the project's authored sandbox lifecycle (…)` — Eveland overrides only the `backend`, while authored `bootstrap()`, `onSession()`, `description`, `revalidationKey`, and workspace seeds remain active.
- A project with no `agent/` directory logs `Injected eve sandbox modules: none` plus a `WARNING` that the deployed agent falls back to eve's default sandbox chain. The build does not fail.
- An environment entry that claims a platform-owned name (`PATH`, `HOME`, `NPM_CONFIG_CACHE`, or a runtime-reserved variable) is dropped from the build with a `WARNING`.

**A build fails when the sandbox does not work under its real runtime permissions, and this is deliberate.** Eve prewarms sandboxes lazily, so a broken bubblewrap setup fails neither `eve build`, `eve start`, nor `/eve/v1/health` — that endpoint returns `200` regardless of sandbox health. Eveland closes the gap with a runtime-specific self-check immediately after the build: it runs the real vendored backend under the exact deployment hardening (unprivileged user, `NoNewPrivileges`, `ProtectSystem=strict` on systemd; the real capability/seccomp settings on Docker), executes a typed `.ts` file with Node, and verifies every platform-owned command including real `rg` and GNU `grep` searches. A passing build logs one of:

```
Sandbox self-check passed: the vendored bwrap backend runs under this host's deployment hardening.
Docker sandbox self-check passed: bwrap executed TypeScript with deployment-equivalent permissions.
```

A failing check fails the build itself. The systemd failure message names the host prerequisites to fix, with the captured probe output appended:

1. `/etc/apparmor.d/bwrap` must exist and grant `userns` — Ubuntu's apt bubblewrap ships no AppArmor profile, and `kernel.apparmor_restrict_unprivileged_userns=1` then blocks non-root bwrap with `setting up uid map: Permission denied`.
2. `/workspace` must already exist as an empty directory; bwrap cannot create that bind destination itself.
3. The complete platform sandbox toolchain must be on `PATH`; Worker preflight reports every missing command in one pass.

A Docker failure reports the image probe output and asks the operator to verify that the local engine supports `SYS_ADMIN`, `NET_ADMIN`, and `seccomp=unconfined`. A passing HTTP health check does not by itself mean the sandbox works — that is precisely why this self-check exists.

Continue with [Troubleshooting](/docs/reference/troubleshooting) for symptom-specific checks, including scheduler, cold-start, and activation failures.

## Deeper reference

- [Troubleshooting reference](/docs/reference/troubleshooting): symptom-indexed triage for concrete failures and error states
- [Runtime and resources](/docs/operations/runtime): systemd/Docker instance lifecycle, resource limits, and process cleanup
- [Sandbox design decisions](/docs/reference/design/sandbox): bubblewrap sandbox self-check and host hardening rationale
