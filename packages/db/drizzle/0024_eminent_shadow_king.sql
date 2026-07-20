CREATE INDEX "model_usage_created_idx" ON "model_usage_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "session_nodes_project_model_idx" ON "session_nodes" USING btree ("project_id","model_id");--> statement-breakpoint
CREATE INDEX "sessions_project_started_idx" ON "sessions" USING btree ("project_id","started_at");