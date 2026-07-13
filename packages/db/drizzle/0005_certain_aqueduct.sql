CREATE TABLE "session_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"root_session_id" text NOT NULL,
	"project_id" text NOT NULL,
	"eve_session_id" text NOT NULL,
	"parent_node_id" text,
	"parent_eve_session_id" text,
	"started_deployment_id" text NOT NULL,
	"last_observed_deployment_id" text NOT NULL,
	"agent_id" text,
	"agent_name" text,
	"node_id" text,
	"channel_kind" text,
	"model_id" text,
	"eve_version" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "session_node_id" text;--> statement-breakpoint
ALTER TABLE "session_events" ADD COLUMN "session_node_id" text;--> statement-breakpoint
ALTER TABLE "session_events" ADD COLUMN "observer_event_id" text;--> statement-breakpoint
ALTER TABLE "session_events" ADD COLUMN "event_fingerprint" text;--> statement-breakpoint
ALTER TABLE "session_events" ADD COLUMN "observed_deployment_id" text;--> statement-breakpoint
ALTER TABLE "session_events" ADD COLUMN "source_sequence" integer;--> statement-breakpoint
ALTER TABLE "session_events" ADD COLUMN "event_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "root_node_id" text;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD CONSTRAINT "session_nodes_root_session_id_sessions_id_fk" FOREIGN KEY ("root_session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD CONSTRAINT "session_nodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD CONSTRAINT "session_nodes_started_deployment_id_deployments_id_fk" FOREIGN KEY ("started_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD CONSTRAINT "session_nodes_last_observed_deployment_id_deployments_id_fk" FOREIGN KEY ("last_observed_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_nodes_project_eve_idx" ON "session_nodes" USING btree ("project_id","eve_session_id");--> statement-breakpoint
INSERT INTO "session_nodes" (
	"id", "root_session_id", "project_id", "eve_session_id", "parent_node_id", "parent_eve_session_id",
	"started_deployment_id", "last_observed_deployment_id", "status", "created_at", "updated_at"
)
SELECT DISTINCT ON ("project_id", "eve_session_id")
	'node_legacy_' || substr(md5("id"), 1, 16), "id", "project_id", "eve_session_id", NULL, NULL,
	"deployment_id", "deployment_id", "status", "started_at", coalesce("completed_at", "started_at")
FROM "sessions"
WHERE "eve_session_id" IS NOT NULL AND "deployment_id" IS NOT NULL
ORDER BY "project_id", "eve_session_id", "started_at" ASC;--> statement-breakpoint
UPDATE "sessions" AS s
SET "root_node_id" = n."id"
FROM "session_nodes" AS n
WHERE n."root_session_id" = s."id" AND n."parent_node_id" IS NULL;--> statement-breakpoint
UPDATE "session_events" AS e
SET "session_node_id" = s."root_node_id"
FROM "sessions" AS s
WHERE e."session_id" = s."id" AND s."root_node_id" IS NOT NULL;--> statement-breakpoint
UPDATE "model_usage_events" AS u
SET "session_node_id" = n."id"
FROM "sessions" AS s, "session_nodes" AS n
WHERE u."session_id" = s."id"
	AND n."root_session_id" = s."id"
	AND n."eve_session_id" = u."eve_session_id";--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD CONSTRAINT "model_usage_events_session_node_id_session_nodes_id_fk" FOREIGN KEY ("session_node_id") REFERENCES "public"."session_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_node_id_session_nodes_id_fk" FOREIGN KEY ("session_node_id") REFERENCES "public"."session_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_observed_deployment_id_deployments_id_fk" FOREIGN KEY ("observed_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_usage_node_turn_step_idx" ON "model_usage_events" USING btree ("session_node_id","turn_id","step_index");--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_node_observer_idx" ON "session_events" USING btree ("session_node_id","observer_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_node_fingerprint_idx" ON "session_events" USING btree ("session_node_id","event_fingerprint");
