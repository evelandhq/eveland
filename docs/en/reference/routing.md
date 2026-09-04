---
title: Routing and deployment lifecycle contract
description: Specification for host addressing, weighted routing, SessionBinding, durable operation bindings, cold activation, and orphan sweeps.
---

This document defines the behavioral specification for public traffic routing and agent deployment lifecycles.

---

## 1. Addressing and Host model

Each deployment retains an immutable release artifact, a dedicated preview hostname, and an assigned runtime adapter:

- **Production stable route**: `http://<projectSlug>.<agentBaseDomain>`
- **Dedicated preview route**: `http://<deploymentKey>--<projectSlug>.<agentBaseDomain>`
- **Identifier convention**: `deploymentKey` is a project-unique 8-character lowercase alphanumeric slug; `dep_xxxxxxxxxx` serves as the internal platform identifier.
- **Certificate compatibility**: The `--` separator is constrained within a single DNS label, allowing one wildcard certificate (`*.agents.example.com`) to cover stable, preview, and alias routes.

---

## 2. Preview, promotion, and weighted routing

- **Atomic promotion**: Build and deploy operations produce isolated preview environments. Promoting a release updates route pointers at the gateway layer within milliseconds without rebuilding the release.
- **Dual-target weighted splitting**: Routes can target up to two deployments simultaneously, splitting traffic using basis points summing to 10,000 (100%).
- **Automatic failover**: If one target in a weighted pair becomes unhealthy (failed, starting, draining, or stopped), the gateway automatically reroutes unpinned new sessions to the surviving healthy target, avoiding client-facing errors.

---

## 3. Session affinity (SessionBinding)

Once an agent outputs a `sessionId`, the gateway records a durable `SessionBinding`:

- **Affinity enforcement**: Follow-up turns (Continue), cancellations (Cancel), and streaming requests (Stream) are **always forwarded to the originally bound deployment**, even across promotions, rollbacks, or when traffic weight is dropped to zero.
- **Expiration policy**: Playground bindings expire after 24 hours of inactivity; public API bindings expire after 7 days idle. Inactive expired sessions return `410 session_expired`.

---

## 4. Durable routes and OperationBinding

Eve durable routes (create-once, task-input, MCP invocation) follow strict binding rules:

- **First-write-wins**: Create requests bearing an `operationId` compute an HMAC operation key using an internal gateway secret, persisting an `OperationBinding` per `(projectId, operationKey)`. Plaintext IDs are never stored.
- **MCP task tracking**: The `invocationId` returned by MCP `agent_start` is bound to the target deployment, ensuring subsequent `agent_get`, `agent_update`, and `agent_cancel` requests return to the same agent.
- **Callback routing**: Reverse proxies must forward both `/eve/*` and `/.well-known/workflow/*` to permit workflow callback delivery.

---

## 5. Deployment lifecycle state machine

A deployment progresses through the following deterministic states:

$$\text{running} \longrightarrow \text{draining} \longrightarrow \text{stopped} \longrightarrow \text{archiving} \longrightarrow \text{archived}$$

- **Retention safeguards**: The latest N releases, active route targets, unexpired SessionBindings, and active ActivationLeases are protected from automatic archiving.
- **Automated pruning**: Worker periodically scans stopped and unprotected deployments, transitioning them atomically to `archiving` before purging disk artifacts and build directories.

---

## 6. Cold activation and scale-to-zero

- **Lease acquisition**: Requests, schedules, and workflow steps acquire a temporary `ActivationLease`.
- **Coalesced starts**: When waking dormant deployments, concurrent incoming requests are coalesced into a single cold-start operation. The gateway waits up to 30 seconds for readiness.
- **Graceful shutdown**: After all leases expire and the idle timeout passes (default: 5 minutes), the Worker stops the process to reclaim memory.

---

## 7. Port reservation and orphan sweeps

- **Unique port reservation**: Starters reserve listening ports in the database prior to binding, preventing port collisions.
- **Orphan reconciliation**: The Worker runs periodic sweeps on the host, shutting down unmanaged `eveland-*-dep_*` units that lack active database deployment records.
- **Diagnostic capture on failure**: If an instance fails its HTTP readiness probe, the Worker automatically captures journal traces and masks secrets before stopping the unit.

## Deeper reference

- [Releases and traffic routing](/docs/agents/releases-routing): guide to immutable previews and session affinity
- [Agent Gateway invariants](/docs/reference/design/gateway): data-plane invariants and Host validation rationale
- [Scale to zero and cold activation](/docs/reference/design/scale-to-zero): activation leases and lifecycle governance
- [Health and diagnostics](/docs/operations/diagnostics): runtime diagnostics capture and evidence inspection
