CREATE TABLE "operation_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"route_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"trigger" text NOT NULL,
	"variant_name" text,
	"experiment_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operation_bindings_trigger_check" CHECK ("operation_bindings"."trigger" in ('api', 'playground'))
);
--> statement-breakpoint
ALTER TABLE "operation_bindings" ADD CONSTRAINT "operation_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_bindings" ADD CONSTRAINT "operation_bindings_route_id_agent_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."agent_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_bindings" ADD CONSTRAINT "operation_bindings_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operation_bindings_project_key_idx" ON "operation_bindings" USING btree ("project_id","operation_key");