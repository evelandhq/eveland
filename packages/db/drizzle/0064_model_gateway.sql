CREATE TABLE "model_gateway" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"base_url" text,
	"encrypted_credential" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_gateway_key_check" CHECK ("model_gateway"."key" = 'global'),
	CONSTRAINT "model_gateway_kind_check" CHECK ("model_gateway"."kind" in ('vercel', 'openrouter', 'litellm', 'openai-compatible')),
	CONSTRAINT "model_gateway_revision_check" CHECK ("model_gateway"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "project_model_gateway" (
	"project_id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'platform' NOT NULL,
	"encrypted_project_key" text,
	"issued_key_alias" text,
	"issued_key_encrypted" text,
	"issued_key_gateway_identity" text,
	"issued_key_state" text,
	"issued_key_issued_at" timestamp with time zone,
	"pending_rotation_key_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_model_gateway_mode_check" CHECK ("project_model_gateway"."mode" in ('platform', 'project-key', 'off')),
	CONSTRAINT "project_model_gateway_issued_key_state_check" CHECK ("project_model_gateway"."issued_key_state" is null or "project_model_gateway"."issued_key_state" in ('pending', 'registered')),
	CONSTRAINT "project_model_gateway_issued_key_complete_check" CHECK (("project_model_gateway"."issued_key_alias" is null) = ("project_model_gateway"."issued_key_encrypted" is null)
        and ("project_model_gateway"."issued_key_alias" is null) = ("project_model_gateway"."issued_key_gateway_identity" is null)
        and ("project_model_gateway"."issued_key_alias" is null) = ("project_model_gateway"."issued_key_state" is null)
        and ("project_model_gateway"."issued_key_alias" is null) = ("project_model_gateway"."issued_key_issued_at" is null))
);
--> statement-breakpoint
ALTER TABLE "project_model_gateway" ADD CONSTRAINT "project_model_gateway_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;