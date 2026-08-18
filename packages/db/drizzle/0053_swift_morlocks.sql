CREATE TABLE "workflow_dispatcher_registrations" (
	"instance_id" text PRIMARY KEY NOT NULL,
	"generation" text NOT NULL,
	"state" text NOT NULL,
	"ownership_acquired" boolean NOT NULL,
	"boot_recovery_completed" boolean NOT NULL,
	"reenqueued_runs" integer,
	"world_database_identity" text NOT NULL,
	"schema_generation" text,
	"protocol_min" integer NOT NULL,
	"protocol_max" integer NOT NULL,
	"cutover_operation_id" text,
	"unscoped_runnable_jobs" integer,
	"unresolved_quarantines" integer,
	"desired_state" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone NOT NULL
);
