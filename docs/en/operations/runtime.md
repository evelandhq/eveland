---
title: Runtime and resources
description: Manage agent process lifecycles, on-demand cold starts, resource limits, durable workflows, and orphan reconciliation.
---

In Eveland, **a deployment's identity and its underlying operating system process lifecycle are strictly decoupled**. Even when an agent process is stopped due to inactivity, its immutable release artifact, preview hostname, production route, and active session bindings are permanently preserved.

---

## 1. Process lifecycle and scale-to-zero

Eveland utilizes a lease-based model (ActivationLease) to automatically scale agent processes down to zero when idle, maximizing host capacity:

```text
Incoming request / Cron schedule / Workflow step
  → Acquire short-lived ActivationLease
  → If dormant (stopped), Worker cold-starts the exact Release in milliseconds
  → Gateway proxies traffic / Step executes
  → Request finishes, lease released
  → Idle window lapses (default: 5 minutes with no leases), Worker gracefully stops process
```

- **Coalesced activations**: Concurrent requests arriving for the same dormant deployment are coalesced into a single activation job.
- **State preservation**: Scaling to zero frees CPU and RAM while leaving immutable release artifacts and conversation bindings untouched.

---

## 2. Deployment execution model and security

| Phase      | Execution Environment & Isolation                 | Key Actions                                                                                                                                                          |
| :--------- | :------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Build**  | Unprivileged `eveland-build` + bubblewrap sandbox | Executes `npm ci` and `npx eve build` in a restricted sandbox. Worker credentials and database keys are stripped from the environment.                               |
| **Run**    | Ephemeral systemd `DynamicUser` service           | Binds exclusively to private loopback (`127.0.0.1:18000–18999`) with `ProtectSystem=strict` and `PrivateTmp`. Secrets arrive via root-owned `0600` files.            |
| **Health** | Local HTTP probe                                  | Worker polls `http://127.0.0.1:<port>/eve/v1/health`. If health checks time out, recent journal output and masked diagnostics are captured before stopping the unit. |
| **Idle**   | Process stopped, metadata preserved               | Memory is released. Immutable release artifacts, routes, and session affinities persist.                                                                             |

---

## 3. Resource quotas and limits

Configure cgroup limits per deployment via global environment variables:

```ini
# Maximum memory per agent process
EVELAND_MEMORY_MAX=512M

# CPU quota per agent process (e.g. 100% corresponds to 1 CPU core)
EVELAND_CPU_QUOTA=100%

# Maximum concurrent tasks/threads per process
EVELAND_TASKS_MAX=1024

# Sandbox command execution timeout in milliseconds (default: 10 minutes)
EVELAND_SANDBOX_RUN_TIMEOUT_MS=600000
```

_For comprehensive hardware sizing recommendations, see [Capacity planning](/docs/operations/capacity)._

---

## 4. Sandbox injection and persistent workspaces

Built-in Eve tools for code execution and file inspection (`bash`, `read_file`, `write_file`) are driven by `@evelandhq/sandbox-bwrap`:

- **Native compatibility**: Eveland injects the bubblewrap backend into compiled releases while preserving user-defined `bootstrap()`, `onSession()`, and workspace seeds (`agent/sandbox/workspace/**`).
- **Session workspace isolation**: Each persistent conversation retains its own isolated `/workspace` directory. Redeployments or cold starts preserve existing session workspaces without data loss.

---

## 5. Durable workflow engine (Shared Workflow World)

Durable workflows ensure timers and asynchronous callbacks resume accurately even when the parent agent has scaled to zero:

- **Singleton external dispatcher**: Driven by a single [Workflow Dispatcher](/docs/production/workflow-dispatcher) holding a PostgreSQL advisory lock across the cluster.
- **Tenant isolation**: All agents share a single workflow database (`EVELAND_WORKFLOW_WORLD_URL`), partitioned logically by `tenant_id` (project ID).
- **Engine injection**: During release compilation, Eveland automatically injects `@evelandhq/workflow-world@0.14.0` (superseding legacy `@workflow/world-postgres@5.0.0-beta.34`), delegating execution states strictly to the external dispatcher.
- **Automated migrations**: Worker startup and project provisioning automatically apply schema migrations safely.

### Workflow retention classes

| Trigger Source                          | Default Class | Cleanup Policy and Deadlines                                                  |
| :-------------------------------------- | :------------ | :---------------------------------------------------------------------------- |
| **Schedules**                           | `scheduled`   | Compactable 1 min post-terminal; success kept 24h, failure kept 7 days.       |
| **Interactive (Playground / HTTP API)** | `interactive` | Default class. Success kept 24h, failure kept 7 days, graph kept 30 days.     |
| **Durable Operations**                  | `persistent`  | Critical workflows explicitly designated by the platform; never auto-deleted. |

---

## 6. Reconciliation and orphan recovery

Worker runs continuous background sweeps to ensure host system processes match database records:

- **Unmanaged process adoption**: If a healthy process exists for a legitimate running deployment, Worker adopts it into the idle-reaping lifecycle.
- **Orphan process termination**: Processes belonging to archived, failed, or deleted deployments are stopped after a grace period.
- **Port reservation verification**: Starter jobs verify socket ownership before marking deployments ready, preventing port collisions.

---

## 7. Project deletion lifecycle

Invoking `DELETE /projects/:projectId` runs an asynchronous teardown pipeline:

1. Marks project status as `deleting`, rejecting further mutations;
2. Stops all running and draining deployment processes;
3. Removes project release artifacts, source checkouts, and sandbox caches under `EVELAND_DATA_DIR`;
4. Drops tenant partitions in the shared workflow database;
5. Deletes control plane database records. Any failure leaves the job retryable.

## Deeper reference

- [Production architecture](/docs/production): system topology and service layers
- [Scale-to-zero design decisions](/docs/reference/design/scale-to-zero): cold activation mechanisms
- [Security model](/docs/operations/security): sandbox isolation and privilege boundaries
- [Capacity planning](/docs/operations/capacity): memory, CPU, and database connection sizing
