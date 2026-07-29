-- Pre-index cleanup: production incident #167 left multiple live
-- RuntimeInstances holding the same endpoint_port. Keep the newest live
-- claimant per port (by started_at, then generation) and fail the rest so the
-- unique index below can build. The failed rows' deployments are corrected by
-- the worker's reconcile pass on its next tick.
UPDATE "runtime_instances" AS victim
SET "status" = 'failed',
    "stopped_at" = now(),
    "last_error" = 'Port reservation conflict: another live RuntimeInstance holds this endpoint_port (pre-live-port-index cleanup).'
WHERE victim."status" IN ('starting', 'ready', 'draining')
  AND victim."endpoint_port" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "runtime_instances" holder
    WHERE holder."endpoint_port" = victim."endpoint_port"
      AND holder."status" IN ('starting', 'ready', 'draining')
      AND holder."id" <> victim."id"
      AND (holder."started_at", holder."generation", holder."id") > (victim."started_at", victim."generation", victim."id")
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_instances_live_port_idx" ON "runtime_instances" USING btree ("endpoint_port") WHERE "runtime_instances"."status" in ('starting', 'ready', 'draining') and "runtime_instances"."endpoint_port" is not null;
