CREATE TABLE "shared_agent_environment" (
	"key" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_agent_environment_key_check" CHECK ("shared_agent_environment"."key" = 'global'),
	CONSTRAINT "shared_agent_environment_revision_check" CHECK ("shared_agent_environment"."revision" > 0)
);
--> statement-breakpoint
DROP TABLE "platform_secret_profile_bindings" CASCADE;--> statement-breakpoint
DROP TABLE "platform_secret_profiles" CASCADE;