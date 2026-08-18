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
- Owners whose Release does not attest `per_run_queue_v1`, speaks a dispatch
  protocol outside the dispatcher window, or carries an event log written
  under an unsupported **storage generation** are managed-terminated —
  protocol and storage are independent axes, and the same full decision
  applies to idle owners, not just those with active runs. There is no
  compatibility bridge in v1: even fully migrated jobs do not help an owner
  that would keep producing unscoped jobs.
- Old jobs are migrated **in place** (same job id, payload, key, schedule,
  attempt history) — never deleted and re-enqueued, because a continuation or
  hook input that never reached the event log exists only in that payload.
- Managed termination is a fail-closed saga:
  `pending → fenced → workflow_safe → control_plane_converged → completed`.
  A mid-phase failure keeps the operation fenced; it never reopens wake.
- Activation is bound to the registered dispatcher **instance**: the
  workflow-step activation call must carry the exact instance id the readiness
  gate approved, so a stale or rogue dispatcher process cannot ride a healthy
  registration.
- The API refuses to boot in `workflow-cutover` mode unless the configured
  operation exists and is not already completed — a typoed or finished
  operation id fails at startup, not at the first 409.
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
   pnpm --filter @evelandhq/worker cutover -- prepare --operation-id <id> \
     --quiescence-verified true --backup-evidence <snapshot ids> \
     [--corrupted-runs tenant:run,...] [--run-families tenant:run:eveSessionId,...] \
     [--no-family tenant:run,...]
   pnpm --filter @evelandhq/worker cutover -- postcondition --operation-id <id>
   ```

   The maintenance boundary from steps 2–3 is a fail-closed gate, not prose:
   `prepare` mutates **nothing** — no fences, no cancellations, no topology —
   until the operator's quiescence-and-backup attestation
   (`--quiescence-verified true --backup-evidence <snapshot ids>`) is durably
   recorded on the operation. It is recorded once; reruns need no flags. A
   run without a proven family on an owner that is merely unknown-**fenced**
   (not terminal) still needs its `--run-families`/`--no-family` disposition —
   a temporary fence is not convergence, and would otherwise leave the family
   without a tombstone once the operator classifies and unfences the owner.

   `prepare` first classifies still-`unknown` owners from their immutable
   systemd artifacts (Docker images stay `unknown` for explicit operator
   disposition and are named in the report), then fences — deployment-scoped
   only for permanently retired owners, run-scoped for individually bad runs —
   terminates/quarantines the non-recoverable, migrates provable
   early-external jobs onto their **exact** per-run queues in place, converges
   the control plane for the retired owners, and stages surviving shared
   deployments to `converting`.

   `prepare` walks the **entire** control-plane inventory, not just owners of
   active runs: every deployment — archived rows included, since the OTLP
   projector accepts any retained row — either classifies, retires, stages, or
   — when it stays `unknown` — gets a deployment fence and the `fenced`
   topology so it cannot wake mid-conversion (archived deployments classify
   and fence but never stage; they have no runtime future to convert).

   Legacy owners are terminated **in their own databases**: run the cutover
   with `WORKFLOW_POSTGRES_URL` set so `prepare` can cancel every active run
   in each retired project's derived `eveland_wf_*` database (the host-side
   connection resolves through `WORKFLOW_POSTGRES_BOOTSTRAP_URL` exactly like
   bootstrap does, so a Deployment-facing `host.docker.internal` URL does not
   strand the termination). Retiring a
   legacy owner in the control plane alone is not workflow safety — if the
   base URL is missing, a legacy World is unreachable, or active runs survive
   the cancel, `prepare` reports it in `holds`, exits non-zero, and the saga
   stays at `fenced`.

   `--run-families` maps managed-terminated runs to their Eve session
   families so their control-plane Sessions are failed and tombstoned
   individually; `--no-family` records the explicit assertion that a run
   projected no Eve family. Both are durable dispositions keyed by the run's
   quarantine marker, so supplying them on a **retry** works even though the
   run was already cancelled on the first pass and no longer shows up as
   active — and they never need re-supplying on later reruns. A terminated run with neither is a **hold**: the
   saga stops at `workflow_safe` (the quarantine satisfies the World
   postcondition, so this gate is the only thing standing between a missing
   tombstone and a late OTLP batch reopening the family). Repeat until
   `prepare` reports `"holds": []` and `postcondition` reports
   `"passed": true` — with `--operation-id` it also records a World-visible
   proof row (`workflow.cutover_proofs`) that the dispatcher preflight
   requires. A **passing** proof is earned, not observed: the database
   postcondition alone would hold for a freshly created operation over a
   quiet shared World, so `passed: true` is recorded only when the operation
   has reached control-plane convergence with no unresolved family
   dispositions; anything less records a failed proof and exits non-zero.

6. **Start the dispatcher recover-paused**
   (`EVELAND_WORKFLOW_DISPATCHER_START_MODE=recover-paused`). Watch its
   registration reach `ready_paused` via
   `GET /internal/workflow/dispatcher/registration`; its own preflight
   re-verifies the unscoped-job postcondition before boot recovery runs, and —
   when `EVELAND_WORKFLOW_CUTOVER_OPERATION_ID` is set — additionally requires
   a **passed** `workflow.cutover_proofs` row for this exact operation (the
   one `cutover postcondition --operation-id` records). The dispatcher never
   reads the control-plane database; the proof lives in the World it already
   owns. Its heartbeat also reports the World's **cluster identity**
   (`cluster:<pg system_identifier>/<database>`, read from the database
   itself), and API-side readiness compares it strictly against the identity
   the control plane derives from `EVELAND_WORKFLOW_WORLD_URL` — two different
   clusters can never look "ready" just because their URLs resemble each
   other.
7. **Verify exact activation** end to end through the cutover API, then
   **resume explicitly**:

   ```bash
   curl -X POST -H "Authorization: Bearer $SERVICE_TOKEN" \
     "$API_URL/internal/workflow/dispatcher/resume"
   ```

   The dispatcher picks the resume up on its next heartbeat and only then
   starts claiming. Both API and Worker run with the same
   `EVELAND_WORKFLOW_CUTOVER_OPERATION_ID`; the cutover API refuses a
   heartbeat or resume for any other operation, and the cutover Worker claims
   only jobs stamped with this exact operation id.

8. **Run the continuity gates** with internal traffic: the recovered run
   completes on its original `deployment_id` only, peak dispatch concurrency
   per run stays 1, and post-recovery continuations/child enqueues land on the
   same per-run queue. The live proof of exactly these properties is
   `pnpm --filter @evelandhq/worker smoke:workflow-dual-release` — two
   semantically different Releases, the decoy promoted, a real dispatcher
   restart, and a duplicated first delivery with both Releases online; run it
   against a staging-shaped platform (API + Worker, the harness owns the
   dispatcher lifecycle) before attesting `--continuity-verified`. Then finalize the staged deployments — finalize is a
   gate, not a setter: it re-verifies the postcondition and refuses any
   deployment that is not `converting` under this exact operation:

   ```bash
   pnpm --filter @evelandhq/worker cutover -- finalize --operation-id <id> \
     --deployments dep_a,dep_b --continuity-verified true
   ```

   The operation reaches `completed` only when finalize refused nothing, every
   deployment the operation staged is now `external` (the staged checkpoint
   only ever grows across `prepare` reruns — a deployment staged once cannot
   drop out of the completion gate), no terminated run remains without a
   proven-or-asserted Eve family, and the operator attested the continuity
   gates with `--continuity-verified true` (recorded as an operation
   checkpoint). Anything short of that leaves the operation retryable at
   `control_plane_converged` and the command exits non-zero.

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
