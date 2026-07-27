CREATE TABLE "identity_login_transactions" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"provider_connection_id" text NOT NULL,
	"provider_security_revision" integer NOT NULL,
	"return_target_id" text NOT NULL,
	"return_path" text NOT NULL,
	"nonce_hash" text,
	"pkce_verifier_encrypted" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_oidc_credentials" (
	"identity_principal_id" text NOT NULL,
	"provider_connection_id" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text,
	"scope" text NOT NULL,
	"access_token_expires_at" timestamp with time zone,
	"rotation_seq" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_oidc_credentials_identity_principal_id_provider_connection_id_pk" PRIMARY KEY("identity_principal_id","provider_connection_id"),
	CONSTRAINT "identity_oidc_credentials_rotation_check" CHECK ("identity_oidc_credentials"."rotation_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "identity_principals" (
	"id" text PRIMARY KEY NOT NULL,
	"identity_realm_id" text NOT NULL,
	"external_subject" text NOT NULL,
	"display_name" text,
	"email" text,
	"claims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_provider_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"display_name" text NOT NULL,
	"internal_realm_key" text,
	"issuer" text,
	"client_id" text,
	"client_secret_encrypted" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"authorization_parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"token_endpoint_auth_method" text,
	"external_realm_resolution" text NOT NULL,
	"external_realm_claim" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"security_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_provider_connections_type_check" CHECK ("identity_provider_connections"."type" in ('internal', 'oidc')),
	CONSTRAINT "identity_provider_connections_revision_check" CHECK ("identity_provider_connections"."security_revision" > 0),
	CONSTRAINT "identity_provider_connections_shape_check" CHECK ((
        "identity_provider_connections"."type" = 'internal'
        and "identity_provider_connections"."internal_realm_key" is not null
        and "identity_provider_connections"."issuer" is null
        and "identity_provider_connections"."client_id" is null
      ) or (
        "identity_provider_connections"."type" = 'oidc'
        and "identity_provider_connections"."internal_realm_key" is null
        and "identity_provider_connections"."issuer" is not null
        and "identity_provider_connections"."client_id" is not null
        and "identity_provider_connections"."token_endpoint_auth_method" in ('client_secret_basic', 'client_secret_post', 'none')
      ))
);
--> statement-breakpoint
CREATE TABLE "identity_realm_project_grants" (
	"identity_realm_id" text NOT NULL,
	"project_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_realm_project_grants_identity_realm_id_project_id_pk" PRIMARY KEY("identity_realm_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "identity_realms" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_connection_id" text NOT NULL,
	"external_realm_id" text NOT NULL,
	"external_realm_kind" text NOT NULL,
	"display_name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_realms_kind_check" CHECK ("identity_realms"."external_realm_kind" in ('internal', 'account', 'corp', 'workspace', 'enterprise', 'tenant', 'organization'))
);
--> statement-breakpoint
CREATE TABLE "identity_return_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"origin" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_return_targets_key_unique" UNIQUE("key"),
	CONSTRAINT "identity_return_targets_origin_unique" UNIQUE("origin")
);
--> statement-breakpoint
CREATE TABLE "identity_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"identity_principal_id" text NOT NULL,
	"active_identity_realm_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "identity_signing_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"algorithm" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_key_encrypted" text NOT NULL,
	"status" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_signing_keys_algorithm_check" CHECK ("identity_signing_keys"."algorithm" = 'ES256'),
	CONSTRAINT "identity_signing_keys_status_check" CHECK ("identity_signing_keys"."status" in ('active', 'retiring', 'retired'))
);
--> statement-breakpoint
ALTER TABLE "identity_login_transactions" ADD CONSTRAINT "identity_login_transactions_provider_connection_id_identity_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."identity_provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_login_transactions" ADD CONSTRAINT "identity_login_transactions_return_target_id_identity_return_targets_id_fk" FOREIGN KEY ("return_target_id") REFERENCES "public"."identity_return_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_oidc_credentials" ADD CONSTRAINT "identity_oidc_credentials_identity_principal_id_identity_principals_id_fk" FOREIGN KEY ("identity_principal_id") REFERENCES "public"."identity_principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_oidc_credentials" ADD CONSTRAINT "identity_oidc_credentials_provider_connection_id_identity_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."identity_provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_principals" ADD CONSTRAINT "identity_principals_identity_realm_id_identity_realms_id_fk" FOREIGN KEY ("identity_realm_id") REFERENCES "public"."identity_realms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_realm_project_grants" ADD CONSTRAINT "identity_realm_project_grants_identity_realm_id_identity_realms_id_fk" FOREIGN KEY ("identity_realm_id") REFERENCES "public"."identity_realms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_realm_project_grants" ADD CONSTRAINT "identity_realm_project_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_realms" ADD CONSTRAINT "identity_realms_provider_connection_id_identity_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."identity_provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_identity_principal_id_identity_principals_id_fk" FOREIGN KEY ("identity_principal_id") REFERENCES "public"."identity_principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_active_identity_realm_id_identity_realms_id_fk" FOREIGN KEY ("active_identity_realm_id") REFERENCES "public"."identity_realms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_login_transactions_expiry_idx" ON "identity_login_transactions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "identity_login_transactions_provider_idx" ON "identity_login_transactions" USING btree ("provider_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_principals_realm_subject_idx" ON "identity_principals" USING btree ("identity_realm_id","external_subject");--> statement-breakpoint
CREATE INDEX "identity_principals_realm_idx" ON "identity_principals" USING btree ("identity_realm_id");--> statement-breakpoint
CREATE INDEX "identity_realm_project_grants_project_idx" ON "identity_realm_project_grants" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_realms_provider_external_idx" ON "identity_realms" USING btree ("provider_connection_id","external_realm_id");--> statement-breakpoint
CREATE INDEX "identity_realms_provider_idx" ON "identity_realms" USING btree ("provider_connection_id");--> statement-breakpoint
CREATE INDEX "identity_sessions_token_idx" ON "identity_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "identity_sessions_principal_idx" ON "identity_sessions" USING btree ("identity_principal_id");--> statement-breakpoint
CREATE INDEX "identity_sessions_expiry_idx" ON "identity_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_signing_keys_one_active_idx" ON "identity_signing_keys" USING btree ("status") WHERE "identity_signing_keys"."status" = 'active';