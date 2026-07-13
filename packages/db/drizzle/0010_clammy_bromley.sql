ALTER TABLE "session_bindings" ADD COLUMN "experiment_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "experiment_id" text;