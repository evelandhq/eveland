CREATE TABLE "project_scheduler_targets" (
	"project_id" text PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"schedule_version_id" text NOT NULL,
	"release_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"missed_ticks" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_runs_trigger_check" CHECK ("schedule_runs"."trigger" in ('cron', 'manual')),
	CONSTRAINT "schedule_runs_status_check" CHECK ("schedule_runs"."status" in ('queued', 'activating', 'dispatching', 'running', 'succeeded', 'failed', 'dispatch_unknown', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "schedule_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"source_revision_id" text NOT NULL,
	"kind" text NOT NULL,
	"cron" text NOT NULL,
	"source_path" text NOT NULL,
	"definition_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_versions_kind_check" CHECK ("schedule_versions"."kind" in ('markdown', 'handler'))
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "schedule_run_id" text;--> statement-breakpoint
ALTER TABLE "project_scheduler_targets" ADD CONSTRAINT "project_scheduler_targets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scheduler_targets" ADD CONSTRAINT "project_scheduler_targets_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_schedules" ADD CONSTRAINT "project_schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_project_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."project_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_version_id_schedule_versions_id_fk" FOREIGN KEY ("schedule_version_id") REFERENCES "public"."schedule_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_versions" ADD CONSTRAINT "schedule_versions_schedule_id_project_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."project_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_versions" ADD CONSTRAINT "schedule_versions_source_revision_id_source_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."source_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_schedules_project_key_idx" ON "project_schedules" USING btree ("project_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_runs_version_due_idx" ON "schedule_runs" USING btree ("schedule_version_id","due_at") WHERE "schedule_runs"."trigger" = 'cron';--> statement-breakpoint
CREATE INDEX "schedule_runs_schedule_status_idx" ON "schedule_runs" USING btree ("schedule_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_versions_schedule_revision_idx" ON "schedule_versions" USING btree ("schedule_id","source_revision_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_schedule_run_id_schedule_runs_id_fk" FOREIGN KEY ("schedule_run_id") REFERENCES "public"."schedule_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_schedule_run_idx" ON "sessions" USING btree ("schedule_run_id");
