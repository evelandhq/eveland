ALTER TABLE "session_nodes" ADD COLUMN "remote_url" text;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD COLUMN "resolution_status" text DEFAULT 'observed' NOT NULL;