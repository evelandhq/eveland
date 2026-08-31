---
title: Routing and deployment lifecycle
description: Behavioral reference for the host model, traffic weights, session/operation bindings, activation and port ownership, and the orphan sweep.
---

This page is the behavioral contract of the public data plane and the deployment lifecycle: the addressing model, preview/promote and weighted routing, session/operation bindings, cold activation and port ownership, and the orphan sweep. The rationale behind the data-plane invariants lives in [Agent Gateway](/docs/reference/design/gateway); the scale-to-zero rationale in [Scale to zero](/docs/reference/design/scale-to-zero); the team-member narrative in [Releases and routing](/docs/agents/releases-routing); process-lifecycle operator facts in [Runtime operations](/docs/operations/runtime).

## The host model

Every deployment owns an immutable release, a preview host, and a runtime adapter, but is not itself a permanently running process. A RuntimeInstance records one generation of a Docker container or systemd unit, and may be `stopped` while the deployment remains addressable, continuable, and retention-protected. A project's stable host is a mutable route; raw dynamic ports are not product URLs and are never exposed publicly.

The canonical development addresses are `http://<projectSlug>.agent.localhost:17302` and `http://<deploymentKey>--<projectSlug>.agent.localhost:17302`. A deployment's public `deploymentKey` is a project-unique 8-character lowercase alphanumeric key; the full `dep_xxxxxxxxxx` remains the internal ID. Previews keep single-level hostnames so one production `*.agents.example.com` wildcard certificate covers stable, preview, and named aliases.

## Preview, promote, and weighted routing

The underlying build/deploy creates a concurrently running preview by default — never stopping the production deployment or reusing its port. The dashboard composes Source (current revision, or sync Git first) and outcome (keep as preview, or promote after health) through the single `Create deployment` dialog; any promoting combination must explicitly promote the exact deployment that job created, never guessing a target by querying "the latest deployment".

The stable route and named aliases can atomically point at one 100% target or at most two weighted targets summing to 10,000 basis points. New sessions use a deterministic affinity bucket; when one target of a dual-target policy is unavailable (failed/starting/draining/stopped), the Agent Gateway must degrade new sessions to the sole healthy target — even at weight 0 — rather than erroring on unpinned requests; 503 only when both targets are unavailable.

## SessionBinding

Once Eve returns a sessionId, a `SessionBinding` is persisted. While the binding is unexpired, continuation, cancel, stream, and ID-addressed session reset return to the original deployment even through promote, rollback, or a weight dropping to zero; every successful use refreshes the binding's `updatedAt` first. Playground bindings expire after 24 idle hours by default and public API bindings after 7 idle days; a known-but-expired binding must return `410` with the stable `session_expired` code — never re-running route weights or landing on another deployment. After a successful reset the platform marks the corresponding platform session complete; the next new session re-selects a deployment per the current route policy.

## Durable routes and OperationBinding

Eve's durable routes (create-once, task-input, MCP invocation) use the same fixed-target rule. When an initial create carries a non-empty `operationId`, the Agent Gateway must first HMAC it with an independent Agent Gateway secret and persist an `OperationBinding` first-write-wins per `(projectId, operationKey)`, never storing or logging the raw operation ID; repeated creates return to the first target even through promote, rollback, zero weight, or a dormant target. The binding decides only the deployment — it does not interpret Eve's agent-principal-based idempotence/authorization semantics; same-named IDs from different principals share at most the target, with the agent still isolating results.

The Gateway does not manufacture retry semantics for an Agent failure. If an initial Eve create returns a JSON 500 with an `errorId`, it forwards the original status and body unchanged, adds the reserved `x-eveland-request-id` response header, and correlates a bounded clone in platform telemetry with the Project, Deployment, activated RuntimeInstance, and HMAC operation key. The raw `operationId` is still neither persisted nor logged. A typed retryable response or committed-run adoption remains Eve's protocol responsibility; Gateway correlation must not guess an exception class from a generic 500.

After a successful MCP `agent_start`, the response's `structuredContent.invocationId` is written as a SessionBinding, and `agent_get`, `agent_update`, and `agent_cancel` return to the original deployment by that invocation ID. The token of `POST /eve/v1/task-input/:token` is fully opaque to the Agent Gateway and must not be persisted; a project's deployments share their durable workflow world, so the callback can resume on any in-window deployment among the route targets and wake a dormant target through the normal ActivationLease. Every line in the current window supports these durable routes, so no per-operation version floors remain; when the selected target is outside the support window, return 409 — never degrading into a plain non-durable forward.

## Deployment lifecycle and archiving

The deployment lifecycle is running, draining, stopped, archiving, archived; the latest three artifacts, mutable route targets, unexpired SessionBindings, unexpired OperationBindings, and active ActivationLeases are all retention-protected. The worker periodically scans unprotected, already-`stopped` old deployments and idempotently enqueues archive jobs; archiving must first atomically claim the target as `archiving` — activation and restart must both reject the deployment while the claim is held — then re-check retention protection after the claim, and only then delete the runtime artifact and the corresponding build directory per the deployment's stored `runtimeKind`, setting `archived` on success; any failure rolls back to the pre-claim state. When a build or start fails before the deployment row is persisted, the prepared build directory and any created runtime artifact must also be deleted — never leaving a release the database cannot address.

## Activation and cold start

Cron, public requests, turns, and streams acquire a bounded ActivationLease before touching the process. Concurrent wakes of the same dormant deployment allow exactly one starter; the API only persists/waits on state and gains no Docker or systemd privilege, and the worker starts the exact release per the deployment's stored `runtimeKind`. The Agent Gateway waits at most 30 seconds (default) for cold start, preserving agent-owned auth, cookies, host semantics, body limits, abort, and NDJSON streaming. Continuations and session resets must wake the original deployment per the SessionBinding — never re-running route weighting. After the last lease releases or expires, the process stops after a default 5 idle minutes; before stopping, a transactional re-check for new leases is mandatory. Worker recovery and reconciliation after startup re-enqueue interrupted activation jobs and correct transient-process states that have actually vanished to stopped/failed.

On runtimes that can identify socket ownership (systemd), readiness must first confirm the listening socket on the deployment's port belongs to its own process: when another process holds the port, activation fails immediately — a deployment must never be marked ready based on some other process's HTTP response. Reconciliation performs the same ownership check on ready RuntimeInstances, correcting the instance and deployment to failed when the port is held by a foreign process, preventing the Agent Gateway from proxying traffic to the wrong agent.

## Port reservation

The listening port is a RuntimeInstance property: the activating starter writes the port reservation into the instance row before any process binds, and a database uniqueness constraint over active states (starting/ready/draining) guarantees at most one live instance per port; leaving an active state releases the reservation automatically. systemd wakes prefer adopting the previous generation's port still held by their own unit, reallocating when adoption fails; Docker's published port is fixed at container creation, and a failed reservation must fail loudly rather than switching ports. `deployments.host_port` is henceforth a first-deploy preference hint, not the authoritative port — the Agent Gateway and internal activation routing use the `endpointPort` returned by activation, falling back to `host_port` only without activation data. `build_deploy` allocates ports after build and before start, holding an in-flight reservation inside the worker process until the deployment row persists.

## The orphan sweep

The worker runs an independent-cadence orphan sweep reconciling actually running `eveland-*-dep_*` processes with the platform: processes holding an active lease or a live RuntimeInstance are untouched; unmanaged processes belonging to a legitimate deployment (deployed before the RuntimeInstance mechanism, or unactivated after restart) are adopted as ready RuntimeInstances only while the deployment is running/draining, thereafter governed by the idle lifecycle; processes with no deployment record, an archived/stopped/failed deployment, or running under a runtimeKind other than their deployment's are stopped after a grace period — processes the platform has decided to stop may only be reaped, never revived.

The sweep's scope includes systemd units stuck activating (auto-restart flapping); transient units configure an explicit StartLimit, so processes that cannot start give up at the limit instead of flapping forever. The sweep matches only the complete deployment naming shape — the platform's own Compose containers (`eveland-postgres-1`, etc.) are never in scope. Docker networks carrying platform telemetry labels whose agent container no longer exists are reclaimed with the same grace period; reclamation must re-confirm the container is still absent, never racing a concurrent start.

## Diagnostics capture on health-check failure

When a newly started or restarted process fails its HTTP health check, the worker must capture runtime diagnostics before cleaning up the process. Docker records container state, exit code, OOM/restart counts, and the last 200 lines of `docker logs`; systemd records unit state, result/restart counts, and the last 200 lines of journal. Before entering the project runtime logs, diagnostics must be masked with the complete project secret set and capped at 32,000 characters. Failures in diagnostics capture or the subsequent cleanup may only append independent errors — never overwriting the original health-check error; responses and persisted logs must never leak secret plaintext.

## Deeper reference

- [Releases and traffic routing](/docs/agents/releases-routing): immutable previews, stable routes, and session affinity
- [Agent Gateway invariants](/docs/reference/design/gateway): data-plane invariants and Host validation rationale
- [Scale to zero and cold activation](/docs/reference/design/scale-to-zero): activation leases, idle reaping, and lifecycle governance
- [Health and diagnostics](/docs/operations/diagnostics): runtime diagnostics capture and evidence inspection
