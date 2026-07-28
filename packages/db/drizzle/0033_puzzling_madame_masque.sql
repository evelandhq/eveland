CREATE TABLE "schedule_run_sessions" (
	"schedule_run_id" text NOT NULL,
	"session_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"last_observed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_run_sessions_schedule_run_id_session_id_pk" PRIMARY KEY("schedule_run_id","session_id"),
	CONSTRAINT "schedule_run_sessions_status_check" CHECK ("schedule_run_sessions"."status" in ('running', 'succeeded', 'failed', 'parked'))
);
--> statement-breakpoint
ALTER TABLE "session_events" ADD COLUMN "observed_runtime_instance_id" text;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD COLUMN "started_runtime_instance_id" text;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD COLUMN "last_observed_runtime_instance_id" text;--> statement-breakpoint
ALTER TABLE "schedule_run_sessions" ADD CONSTRAINT "schedule_run_sessions_schedule_run_id_schedule_runs_id_fk" FOREIGN KEY ("schedule_run_id") REFERENCES "public"."schedule_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_run_sessions" ADD CONSTRAINT "schedule_run_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_run_sessions_status_idx" ON "schedule_run_sessions" USING btree ("schedule_run_id","status");--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_observed_runtime_instance_id_runtime_instances_id_fk" FOREIGN KEY ("observed_runtime_instance_id") REFERENCES "public"."runtime_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD CONSTRAINT "session_nodes_started_runtime_instance_id_runtime_instances_id_fk" FOREIGN KEY ("started_runtime_instance_id") REFERENCES "public"."runtime_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD CONSTRAINT "session_nodes_last_observed_runtime_instance_id_runtime_instances_id_fk" FOREIGN KEY ("last_observed_runtime_instance_id") REFERENCES "public"."runtime_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_nodes_last_runtime_idx" ON "session_nodes" USING btree ("last_observed_runtime_instance_id","status");--> statement-breakpoint
INSERT INTO "schedule_run_sessions" (
	"schedule_run_id",
	"session_id",
	"status",
	"last_observed_at",
	"completed_at"
)
SELECT
	session."schedule_run_id",
	session."id",
	CASE
		WHEN session."status" = 'running' THEN 'running'
		WHEN session."status" = 'failed' THEN 'failed'
		WHEN session."status" IN ('waiting', 'waiting_approval') THEN 'parked'
		ELSE 'succeeded'
	END,
	(
		SELECT max(event."created_at")
		FROM "session_events" AS event
		WHERE event."session_id" = session."id"
	),
	CASE
		WHEN session."status" = 'running' THEN NULL
		ELSE coalesce(
			session."completed_at",
			(
				SELECT max(event."created_at")
				FROM "session_events" AS event
				WHERE event."session_id" = session."id"
			),
			now()
		)
	END
FROM "sessions" AS session
WHERE session."schedule_run_id" IS NOT NULL
ON CONFLICT ("schedule_run_id", "session_id") DO NOTHING;--> statement-breakpoint
UPDATE "schedule_runs" AS run
SET
	"status" = 'running',
	"completed_at" = NULL,
	"updated_at" = now()
WHERE run."status" = 'succeeded'
	AND EXISTS (
		SELECT 1
		FROM "schedule_run_sessions" AS execution
		WHERE execution."schedule_run_id" = run."id"
			AND execution."status" = 'running'
	);
