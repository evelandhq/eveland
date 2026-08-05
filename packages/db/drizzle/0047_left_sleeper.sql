ALTER TABLE "model_usage_events" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD COLUMN "observed_model_id" text;