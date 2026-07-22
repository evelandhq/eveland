CREATE TABLE "deployment_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"target" text NOT NULL,
	"status" text NOT NULL,
	"source_digest" text NOT NULL,
	"git_metadata" jsonb,
	"source_revision_id" text,
	"release_id" text,
	"deployment_id" text,
	"preview_hostname" text,
	"production_hostname" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_operations_target_check" CHECK ("deployment_operations"."target" in ('production', 'preview')),
	CONSTRAINT "deployment_operations_status_check" CHECK ("deployment_operations"."status" in ('importing', 'building', 'deploying', 'promoting', 'ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "deployment_operations" ADD CONSTRAINT "deployment_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_operations" ADD CONSTRAINT "deployment_operations_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_operations" ADD CONSTRAINT "deployment_operations_source_revision_id_source_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."source_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_operations" ADD CONSTRAINT "deployment_operations_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_operations" ADD CONSTRAINT "deployment_operations_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployment_operations_project_created_idx" ON "deployment_operations" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "deployment_operations_status_idx" ON "deployment_operations" USING btree ("status");