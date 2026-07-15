CREATE TABLE "activation_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"runtime_instance_id" text,
	"kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "activation_leases_kind_check" CHECK ("activation_leases"."kind" in ('public_request', 'stream', 'turn', 'schedule_run'))
);
--> statement-breakpoint
CREATE TABLE "runtime_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"generation" integer NOT NULL,
	"status" text NOT NULL,
	"endpoint_host" text,
	"endpoint_port" integer,
	"started_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "runtime_instances_status_check" CHECK ("runtime_instances"."status" in ('starting', 'ready', 'draining', 'stopped', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "activation_leases" ADD CONSTRAINT "activation_leases_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_leases" ADD CONSTRAINT "activation_leases_runtime_instance_id_runtime_instances_id_fk" FOREIGN KEY ("runtime_instance_id") REFERENCES "public"."runtime_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_instances" ADD CONSTRAINT "runtime_instances_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activation_leases_deployment_kind_owner_idx" ON "activation_leases" USING btree ("deployment_id","kind","owner_id");--> statement-breakpoint
CREATE INDEX "activation_leases_active_idx" ON "activation_leases" USING btree ("deployment_id","expires_at","released_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_instances_deployment_generation_idx" ON "runtime_instances" USING btree ("deployment_id","generation");--> statement-breakpoint
CREATE INDEX "runtime_instances_deployment_status_idx" ON "runtime_instances" USING btree ("deployment_id","status");