ALTER TABLE "model_usage_events" ALTER COLUMN "step_index" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "run_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "model_usage_session_eve_run_idx" ON "model_usage_events" USING btree ("session_id","eve_session_id","run_key");--> statement-breakpoint
CREATE UNIQUE INDEX "model_usage_node_run_idx" ON "model_usage_events" USING btree ("session_node_id","run_key");