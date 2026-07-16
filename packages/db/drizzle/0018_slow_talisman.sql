CREATE TABLE "agent_auth_credentials" (
	"agent_connection_id" text NOT NULL,
	"security_revision" integer NOT NULL,
	"auth_method" text NOT NULL,
	"credential_scope" text NOT NULL,
	"scope_subject" text NOT NULL,
	"credential_key" text DEFAULT '' NOT NULL,
	"payload_encrypted" text NOT NULL,
	"expires_at" timestamp with time zone,
	"rotation_seq" integer DEFAULT 0 NOT NULL,
	"refresh_owner" text,
	"refresh_lease_id" text,
	"refresh_lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_auth_credentials_security_revision_check" CHECK ("agent_auth_credentials"."security_revision" > 0),
	CONSTRAINT "agent_auth_credentials_rotation_seq_check" CHECK ("agent_auth_credentials"."rotation_seq" >= 0),
	CONSTRAINT "agent_auth_credentials_scope_check" CHECK (("agent_auth_credentials"."credential_scope" = 'connection' and "agent_auth_credentials"."scope_subject" = '') or ("agent_auth_credentials"."credential_scope" = 'principal' and "agent_auth_credentials"."scope_subject" <> ''))
);
--> statement-breakpoint
CREATE TABLE "agent_auth_transactions" (
	"agent_connection_id" text NOT NULL,
	"state_hash" text PRIMARY KEY NOT NULL,
	"payload_encrypted" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"method" text NOT NULL,
	"config_encrypted" text NOT NULL,
	"security_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_connections_target_kind_check" CHECK ("agent_connections"."target_kind" in ('managed-project')),
	CONSTRAINT "agent_connections_security_revision_check" CHECK ("agent_connections"."security_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "agent_auth_credentials" ADD CONSTRAINT "agent_auth_credentials_agent_connection_id_agent_connections_id_fk" FOREIGN KEY ("agent_connection_id") REFERENCES "public"."agent_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_auth_transactions" ADD CONSTRAINT "agent_auth_transactions_agent_connection_id_agent_connections_id_fk" FOREIGN KEY ("agent_connection_id") REFERENCES "public"."agent_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_auth_credentials_scope_idx" ON "agent_auth_credentials" USING btree ("agent_connection_id","security_revision","auth_method","credential_scope","scope_subject","credential_key");--> statement-breakpoint
CREATE INDEX "agent_auth_transactions_expires_idx" ON "agent_auth_transactions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_connections_project_idx" ON "agent_connections" USING btree ("project_id");