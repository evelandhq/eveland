CREATE TABLE "observability_destination_health" (
	"destination_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"checked_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observability_destination_health_status_check" CHECK ("observability_destination_health"."status" in ('pending', 'healthy', 'degraded', 'paused'))
);
--> statement-breakpoint
CREATE TABLE "observability_policies" (
	"team_id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observability_policies_revision_check" CHECK ("observability_policies"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "otlp_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"signal" text NOT NULL,
	"payload_hash" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otlp_batches_signal_check" CHECK ("otlp_batches"."signal" in ('traces', 'logs', 'metrics'))
);
--> statement-breakpoint
DROP INDEX "host_metric_samples_worker_observed_idx";--> statement-breakpoint
ALTER TABLE "observability_policies" ADD CONSTRAINT "observability_policies_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "otlp_batches_signal_hash_idx" ON "otlp_batches" USING btree ("signal","payload_hash");--> statement-breakpoint
CREATE INDEX "otlp_batches_signal_received_idx" ON "otlp_batches" USING btree ("signal","received_at");--> statement-breakpoint
-- Rows inserted before this migration had no conflict handling, so a worker
-- restart overlap or delivery retry may have left duplicate
-- (worker_id, observed_at) pairs; drop all but one so the unique index below
-- can be created on existing databases.
DELETE FROM "host_metric_samples" AS a
USING "host_metric_samples" AS b
WHERE a."worker_id" = b."worker_id"
  AND a."observed_at" = b."observed_at"
  AND a."id" > b."id";--> statement-breakpoint
CREATE UNIQUE INDEX "host_metric_samples_worker_observed_idx" ON "host_metric_samples" USING btree ("worker_id","observed_at");