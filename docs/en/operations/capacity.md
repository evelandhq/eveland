---
title: Capacity planning
description: "Sizing host hardware: concurrent builds, active agent density, and PostgreSQL connection budgeting."
---

Eveland enables multiple agents to share single-host hardware. When planning resources, consider the footprint of three primary workloads competing for memory, CPU, and database connections:

| Workload                   | Typical Memory  | CPU Pattern                 | PostgreSQL Connections                                  |
| :------------------------- | :-------------- | :-------------------------- | :------------------------------------------------------ |
| **One Build**              | 1–2 GB peak     | Burst (~2 cores)            | **None** (build sandbox has no database access)         |
| **One Active Agent**       | 150–300 MB RSS  | Low idle, burst during turn | Up to `WORKFLOW_POSTGRES_MAX_POOL_SIZE` (default 10)    |
| **Platform Core Services** | ~1–1.5 GB total | Low, stable baseline        | ~30 connections (shared pool for API, Gateway & Worker) |

---

## 1. Concurrency governance

### Active running agents

- **No artificial cap**: With automated scale-to-zero, agents idle for longer than 5 minutes gracefully exit and release their memory. Steady-state process density is determined by **active concurrent traffic**, not total deployed projects.

### Concurrent build limits

- To protect the host from resource exhaustion during build spikes, the Worker automatically derives a build ceiling at boot:
  $$\text{Concurrent Build Cap} = \max(1, \min(\lfloor \text{RAM} / 4\text{GiB} \rfloor, \text{cores} - 2))$$
- Builds exceeding this limit queue gracefully, while lightweight operational jobs (restarts, archives, deletes) continue processing.

---

## 2. PostgreSQL connection budgeting

In PostgreSQL, idle connections consume negligible memory (~2 MB each), whereas running agent processes are significantly more memory-intensive. Size your database connections in the following sequence:

### Calculation sequence

1. **Estimate sustainable concurrent running agents**:
   $$\text{Usable RAM} = \text{Total RAM} - 2\text{GB (OS & Core Services)} - (\text{Concurrent Builds} \times 2\text{GB})$$
   $$\text{Active Concurrent Agents} \approx \frac{\text{Usable RAM}}{0.3\text{GB}}$$
2. **Configure Postgres `max_connections`**:
   $$\text{max\_connections} \approx (\text{Active Agents} \times \text{Pool Size}) + 30\text{ (Core Services)} + 10\text{ (Dispatcher)} + \text{Headroom}$$

---

## 3. Host sizing reference table

| Host Specs           | Concurrent Build Cap | Estimated Active Agents | Recommended `max_connections` |
| :------------------- | :------------------- | :---------------------- | :---------------------------- |
| **4 GB / 2 Cores**   | 1                    | ~5                      | 100 (Default)                 |
| **8 GB / 4 Cores**   | 2                    | ~10–15                  | 200                           |
| **16 GB / 8 Cores**  | 3–4                  | ~30                     | 300–400                       |
| **32 GB / 16 Cores** | 6–8                  | ~60                     | 400+                          |

---

## 4. Disk and port capacity

- **Session workspace caches**: Persistent workspaces located under `EVELAND_DATA_DIR/sandboxes` accumulate with long-lived sessions. Use Worker maintenance routines to list and prune stale templates.
- **Release retention**: Historical releases are governed by platform retention sweeps, automatically purging unused artifacts.
- **Port allocation**: In the systemd runtime, each active deployment binds a private loopback port (`18000–18999`), supporting up to 1,000 concurrent port allocations per host.

## Deeper reference

- [Why systemd, not Docker](/docs/reference/design/runtime): runtime selection and host density rationale
- [Runtime and resources](/docs/operations/runtime): cgroup resource ceilings and sandbox execution budgets
- [Environment variables](/docs/reference/environment-variables): concurrency and capacity environment knobs
