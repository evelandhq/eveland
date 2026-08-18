# Shared workflow World external-only cutover runbook

This is the operator runbook for the one-time maintenance-downtime cutover
(issue #278): after it, every new Release builds against the shared
`@evelandhq/workflow-world`, the runner is external-only, and historical
topologies are either converted, managed-terminated, or durably quarantined.
The design and invariants live in
`docs/superpowers/plans/2026-08-18-shared-workflow-world-external-cutover-handoff.md`;
this file is the executable order of operations.

Every command below is idempotent under one operation id and prints a
machine-readable JSON report of exactly which objects are unclassified,
unterminated, or blocking readiness. Never infer state from logs.

## Invariants the tooling enforces for you

- The dispatcher's `recover-paused` startup refuses to run boot recovery while
  any early-external job is still claimable outside a per-run
  `wfrun:<tenant>:<run>` queue (`cutover postcondition` must pass first).
- A run that is not provably recoverable gets a **durable quarantine marker in
  the workflow database** — boot recovery skips it, the dispatch handler parks
  racing jobs for it, and the deployment-side enqueue refuses it. A
  control-plane fence alone never satisfies the startup gate.
- Owners whose Release does not attest `per_run_queue_v1` are
  managed-terminated. There is no compatibility bridge in v1: even fully
  migrated jobs do not help an owner that would keep producing unscoped jobs.
- Old jobs are migrated **in place** (same job id, payload, key, schedule,
  attempt history) — never deleted and re-enqueued, because a continuation or
  hook input that never reached the event log exists only in that payload.
- Managed termination is a fail-closed saga:
  `pending → fenced → workflow_safe → control_plane_converged → completed`.
  A mid-phase failure keeps the operation fenced; it never reopens wake.
- Session-family tombstones and retired-deployment projection fences keep
  late/replayed OTLP batches from re-materializing terminated Sessions; raw
  batches remain stored as audit data.

## Order of operations

1. **Choose the operation id** (e.g. `cut_2026_08_18`) and record the live
   Docker/systemd runtime inventory as audit evidence. This is not the backup.
2. **Stop everything**: public Web/Gateway ingress, API, Worker, scheduler,
   Collector ingest, the dispatcher, and every Agent deployment. Verify
   quiescence from the control plane, the workflow databases, and the process
   manager. Partial stops are not a maintenance boundary.
3. **Create the formal rollback backups** only after quiescence is verified:
   control-plane database, shared workflow database, all legacy per-project
   databases, the Collector persistent queue, and `EVELAND_DATA_DIR`. Record
   snapshot identities. No backup, no migration.
4. **Apply migrations** (control plane `pnpm --filter @evelandhq/api
db:migrate`; the shared World migrates itself on the next start). Historical
   Release/Deployment topology columns migrate to `unknown`/`unclassified` and
   never to a guessed value.
5. **Inventory and prepare** with the cutover API/Worker process mode up
   (`EVELAND_PROCESS_MODE=workflow-cutover`,
   `EVELAND_WORKFLOW_CUTOVER_OPERATION_ID=<id>` on both):

   ```bash
   pnpm --filter @evelandhq/worker cutover -- inventory --operation-id <id>
   pnpm --filter @evelandhq/worker cutover -- prepare --operation-id <id>
   pnpm --filter @evelandhq/worker cutover -- postcondition
   ```

   `prepare` fences, terminates/quarantines the non-recoverable, migrates
   provable early-external jobs in place, converges the control plane, and
   stages surviving shared deployments to `converting`. Repeat until
   `postcondition` reports `"passed": true`.

6. **Start the dispatcher recover-paused**
   (`EVELAND_WORKFLOW_DISPATCHER_START_MODE=recover-paused`). Watch its
   registration reach `ready_paused` via
   `GET /internal/workflow/dispatcher/registration`; its own preflight
   re-verifies the unscoped-job postcondition before boot recovery runs.
7. **Verify exact activation** end to end through the cutover API, then
   **resume explicitly**:

   ```bash
   curl -X POST -H "Authorization: Bearer $SERVICE_TOKEN" \
     "$API_URL/internal/workflow/dispatcher/resume"
   ```

   The dispatcher picks the resume up on its next heartbeat and only then
   starts claiming.

8. **Run the continuity gates** with internal traffic: the recovered run
   completes on its original `deployment_id` only, peak dispatch concurrency
   per run stays 1, and post-recovery continuations/child enqueues land on the
   same per-run queue. Then finalize the staged deployments:

   ```bash
   pnpm --filter @evelandhq/worker cutover -- finalize --operation-id <id> \
     --deployments dep_a,dep_b
   ```

9. **Restart API/Worker in normal mode** (drop `EVELAND_PROCESS_MODE`), keep
   ingress closed until readiness passes, then reopen Gateway/Web. When the
   Collector resumes, verify a replayed batch does not project a running
   Session (the tombstones/fences hold).

Any failure at any step: leave public ingress closed, leave fences and
quarantine markers standing, leave the dispatcher paused, and re-run the
idempotent step after fixing the cause. Once the formal backups exist, any
further mutation must carry the operation id; never reopen an old producer and
keep using the same backup.

## Rollback boundary

Rollback never points a shared Release at a legacy database and never demotes
migrated jobs back to the unscoped queue. It means: a new maintenance window,
drain, fresh quiesced backups, and only binaries that understand the topology
columns, the per-run queue contract, `queue_namespace`, run recoverability,
and the current schema. New builds remain shared/external after any rollback.
