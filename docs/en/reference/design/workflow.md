---
title: Workflow architecture design decisions
description: Rationale for external workflow dispatching and the purpose-built shared Workflow World engine.
---

## 1. Why an external dispatcher is mandatory

Durable workflows ensure timers and asynchronous continuation steps fire accurately _after_ the parent agent process has been idle-reaped.

Embedded in-process runners live inside the agent process, terminating when the agent [scales to zero](/docs/reference/design/scale-to-zero). Eveland therefore strictly runs workflows in external mode:

- **Decoupled execution**: Deployments never claim their own workflow jobs;
- **Singleton guarantee**: Exactly one [Workflow Dispatcher](/docs/production/workflow-dispatcher) runs per installation, claiming due tasks from the database and waking target agents via internal activation endpoints to post execution steps;
- **Advisory locks**: Mutual exclusion is enforced via PostgreSQL advisory locks, strictly preventing concurrent replica execution.

---

## 2. Why a purpose-built shared Workflow World (`@evelandhq/workflow-world`)

In multi-tenant enterprise environments, upstream workflow implementations introduce critical cross-tenant vulnerabilities:

1. **Cross-project task stealing**: Upstream libraries claim tasks via fixed worker task identifiers, allowing any running agent to inadvertently claim queued tasks belonging to another agent and execute them with incorrect code and credentials.
2. **The physical database trap**: Provisioning a separate physical database per project exhausts connection pools, complicates backups, and fails when durable task-input callbacks must be shared across deployments.
3. **The correct solution: A shared, tenant-partitioned engine**:
   Eveland built [`@evelandhq/workflow-world`](https://github.com/evelandhq/workflow-world):
   - **Dispatcher-only claiming**: Task claiming is restricted exclusively to the external dispatcher, structurally eliminating task stealing;
   - **Tenant partitioning**: Uses `tenant_id` (project ID) for strict logical partitioning, allowing all agents to share a single database backend securely;
   - **Release-time injection**: Automatically injected during release compilation, requiring zero proprietary workflow code in user repositories.

## Deeper reference

- [Install the workflow dispatcher](/docs/production/workflow-dispatcher): host dispatcher setup and registration gating
- [Runtime and resources](/docs/operations/runtime): durable workflow world tenant partitioning and retention classes
- [Schedules and automation](/docs/observe/schedules): developer guide to schedule execution and workflow models
