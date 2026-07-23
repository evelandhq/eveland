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
CREATE TABLE "otlp_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"signal" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otlp_batches_signal_check" CHECK ("otlp_batches"."signal" in ('traces', 'logs', 'metrics'))
);
--> statement-breakpoint
ALTER TABLE "session_events" RENAME COLUMN "observer_event_id" TO "telemetry_event_id";--> statement-breakpoint
DROP INDEX "session_events_node_observer_idx";--> statement-breakpoint
DROP INDEX "host_metric_samples_worker_observed_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "otlp_batches_signal_hash_idx" ON "otlp_batches" USING btree ("signal","payload_hash");--> statement-breakpoint
CREATE INDEX "otlp_batches_signal_received_idx" ON "otlp_batches" USING btree ("signal","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_node_telemetry_idx" ON "session_events" USING btree ("session_node_id","telemetry_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "host_metric_samples_worker_observed_idx" ON "host_metric_samples" USING btree ("worker_id","observed_at");