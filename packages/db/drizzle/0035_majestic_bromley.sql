ALTER TABLE "session_events" RENAME COLUMN "observer_event_id" TO "telemetry_event_id";--> statement-breakpoint
DROP INDEX "session_events_node_observer_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_node_telemetry_idx" ON "session_events" USING btree ("session_node_id","telemetry_event_id");