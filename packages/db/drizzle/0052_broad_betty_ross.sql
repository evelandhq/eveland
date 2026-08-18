-- Release workflow attestation and Deployment execution topology (issue #278
-- external-only cutover). Historical rows are deliberately backfilled to
-- 'unknown'/'unclassified': the cutover classifies them from immutable
-- artifacts later, and until then activation/restart/archive fail closed
-- instead of guessing a topology. The columns are added with a default only to
-- backfill, then the default is dropped so every future writer must state the
-- value explicitly (same pattern as deployments.runtime_kind).
ALTER TABLE "deployments" ADD COLUMN "workflow_runner_mode" text NOT NULL DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "workflow_runner_mode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "workflow_conversion_state" text NOT NULL DEFAULT 'unclassified';--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "workflow_conversion_state" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "workflow_conversion_operation_id" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "workflow_runner_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "workflow_converted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "workflow_world_kind" text NOT NULL DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE "releases" ALTER COLUMN "workflow_world_kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "workflow_world_package" text;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "workflow_world_version" text;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "workflow_storage_spec" integer;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "workflow_dispatch_protocol" integer;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "workflow_enqueue_capability" text NOT NULL DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE "releases" ALTER COLUMN "workflow_enqueue_capability" DROP DEFAULT;
