CREATE TABLE "agent_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"hostname" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"policy_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_targets" (
	"route_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"weight" integer NOT NULL,
	"variant_name" text
);
--> statement-breakpoint
CREATE TABLE "session_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"eve_session_id" text NOT NULL,
	"route_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"trigger" text NOT NULL,
	"variant_name" text,
	"request_id" text NOT NULL,
	"remote_ip" text,
	"affinity_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "deployment_key" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "routing_key" text;--> statement-breakpoint
UPDATE "projects" SET "routing_key" = 'p-' || substring(md5("id"), 1, 12) WHERE "routing_key" IS NULL;--> statement-breakpoint
UPDATE "deployments" SET "deployment_key" = 'd-' || substring(md5("id"), 1, 12) WHERE "deployment_key" IS NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "routing_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "deployment_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "route_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "variant_name" text;--> statement-breakpoint
INSERT INTO "agent_routes" ("id", "project_id", "hostname", "kind", "enabled", "policy_revision")
SELECT 'route_' || substring(md5('project:' || "id"), 1, 20), "id", "routing_key" || '.agent.localhost', 'project', true, 1
FROM "projects";--> statement-breakpoint
INSERT INTO "agent_routes" ("id", "project_id", "hostname", "kind", "enabled", "policy_revision")
SELECT 'route_' || substring(md5('deployment:' || d."id"), 1, 20), d."project_id", d."deployment_key" || '--' || p."routing_key" || '.agent.localhost', 'deployment', true, 1
FROM "deployments" d JOIN "projects" p ON p."id" = d."project_id";--> statement-breakpoint
INSERT INTO "route_targets" ("route_id", "deployment_id", "weight", "variant_name")
SELECT ar."id", p."deployment_id", 10000, NULL
FROM "agent_routes" ar JOIN "projects" p ON p."id" = ar."project_id"
WHERE ar."kind" = 'project' AND p."deployment_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "route_targets" ("route_id", "deployment_id", "weight", "variant_name")
SELECT ar."id", d."id", 10000, NULL
FROM "agent_routes" ar JOIN "deployments" d ON ar."hostname" LIKE d."deployment_key" || '--%'
WHERE ar."kind" = 'deployment';--> statement-breakpoint
ALTER TABLE "agent_routes" ADD CONSTRAINT "agent_routes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_targets" ADD CONSTRAINT "route_targets_route_id_agent_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."agent_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_targets" ADD CONSTRAINT "route_targets_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_bindings" ADD CONSTRAINT "session_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_bindings" ADD CONSTRAINT "session_bindings_route_id_agent_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."agent_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_bindings" ADD CONSTRAINT "session_bindings_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_routes_hostname_idx" ON "agent_routes" USING btree ("hostname");--> statement-breakpoint
CREATE UNIQUE INDEX "route_targets_route_deployment_idx" ON "route_targets" USING btree ("route_id","deployment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_bindings_project_eve_idx" ON "session_bindings" USING btree ("project_id","eve_session_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_route_id_agent_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."agent_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_deployment_key_unique" UNIQUE("deployment_key");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_routing_key_unique" UNIQUE("routing_key");
