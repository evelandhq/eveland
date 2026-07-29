CREATE INDEX "jobs_queued_claim_idx" ON "jobs" USING btree ("created_at","sequence") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_running_project_idx" ON "jobs" USING btree ("project_id","locked_at") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "jobs_project_created_idx" ON "jobs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "logs_project_created_idx" ON "logs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "session_nodes_root_session_idx" ON "session_nodes" USING btree ("root_session_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_project_eve_session_idx" ON "sessions" USING btree ("project_id","eve_session_id");