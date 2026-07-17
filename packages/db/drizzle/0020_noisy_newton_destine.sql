CREATE TABLE "platform_secret_profile_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"project_id" text NOT NULL,
	"deployment_id" text,
	"target_key" text NOT NULL,
	"consumer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_secret_profile_bindings_consumer_check" CHECK ("platform_secret_profile_bindings"."consumer" in ('agent-runtime', 'agent-connection')),
	CONSTRAINT "platform_secret_profile_bindings_target_check" CHECK (coalesce("platform_secret_profile_bindings"."deployment_id", '') = "platform_secret_profile_bindings"."target_key")
);
--> statement-breakpoint
ALTER TABLE "platform_secret_profile_bindings" ADD CONSTRAINT "platform_secret_profile_bindings_profile_id_platform_secret_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."platform_secret_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_secret_profile_bindings" ADD CONSTRAINT "platform_secret_profile_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_secret_profile_bindings" ADD CONSTRAINT "platform_secret_profile_bindings_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_secret_profile_bindings_target_consumer_idx" ON "platform_secret_profile_bindings" USING btree ("project_id","target_key","consumer");