CREATE TABLE "activation_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"runtime_instance_id" text,
	"kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "activation_leases_kind_check" CHECK ("activation_leases"."kind" in ('public_request', 'stream', 'turn', 'schedule_run', 'workflow_step'))
);
--> statement-breakpoint
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
	CONSTRAINT "agent_connections_target_kind_check" CHECK ("agent_connections"."target_kind" = 'managed-project'),
	CONSTRAINT "agent_connections_security_revision_check" CHECK ("agent_connections"."security_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"hostname" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"policy_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_routes_kind_check" CHECK ("agent_routes"."kind" in ('project', 'deployment', 'alias'))
);
--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"issuer" text DEFAULT 'local:credential' NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_device_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"last_polled_at" timestamp with time zone,
	"polling_interval" integer,
	"client_id" text,
	"scope" text,
	"resources" text[],
	"oauth_client_id" text
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"active_team_id" text,
	"impersonated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"deployment_key" text NOT NULL,
	"project_id" text NOT NULL,
	"release_id" text NOT NULL,
	"container_name" text NOT NULL,
	"internal_port" integer NOT NULL,
	"host_port" integer NOT NULL,
	"status" text NOT NULL,
	"runtime_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_key_check" CHECK ("deployments"."deployment_key" ~ '^[a-z0-9]{8}$')
);
--> statement-breakpoint
CREATE TABLE "git_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"host" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_metric_samples" (
	"id" text PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"cpu_percent" double precision,
	"load_1" double precision NOT NULL,
	"memory_total_bytes" bigint NOT NULL,
	"memory_available_bytes" bigint NOT NULL,
	"disk_total_bytes" bigint NOT NULL,
	"disk_available_bytes" bigint NOT NULL,
	"disk_inodes_total" bigint,
	"disk_inodes_available" bigint,
	"cpu_cores" integer,
	"pg_connections" jsonb
);
--> statement-breakpoint
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
	CONSTRAINT "identity_provider_connections_type_check" CHECK ("identity_provider_connections"."type" in ('internal', 'oidc', 'open')),
	CONSTRAINT "identity_provider_connections_revision_check" CHECK ("identity_provider_connections"."security_revision" > 0),
	CONSTRAINT "identity_provider_connections_shape_check" CHECK ((
        "identity_provider_connections"."type" = 'open'
        and "identity_provider_connections"."internal_realm_key" is null
        and "identity_provider_connections"."issuer" is null
        and "identity_provider_connections"."client_id" is null
      ) or (
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
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_role_check" CHECK ("invitations"."role" in ('admin', 'member')),
	CONSTRAINT "invitations_status_check" CHECK ("invitations"."status" in ('pending', 'accepted', 'rejected', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"locked_at" timestamp with time zone,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "jobs_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"deployment_id" text,
	"type" text NOT NULL,
	"line" text NOT NULL,
	"seq" bigserial NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_gateway" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"base_url" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_gateway_key_check" CHECK ("model_gateway"."key" = 'global'),
	CONSTRAINT "model_gateway_kind_check" CHECK ("model_gateway"."kind" in ('litellm', 'openrouter', 'vercel', 'openai-compatible')),
	CONSTRAINT "model_gateway_base_url_check" CHECK (("model_gateway"."kind" = 'vercel') = ("model_gateway"."base_url" is null)),
	CONSTRAINT "model_gateway_revision_check" CHECK ("model_gateway"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "model_usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"session_node_id" text,
	"eve_session_id" text NOT NULL,
	"agent_id" text,
	"agent_name" text,
	"turn_id" text NOT NULL,
	"run_key" text NOT NULL,
	"model_id" text,
	"finish_reason" text,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cache_read_tokens" bigint,
	"cache_write_tokens" bigint,
	"cost_usd" double precision,
	"usage_reported" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"refresh_id" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"revoked" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_assertions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" boolean,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"client_credentials_scopes" text[],
	"user_id" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text[],
	"response_types" text[],
	"require_pkce" boolean,
	"dpop_bound_access_tokens" boolean DEFAULT false,
	"reference_id" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "oauth_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"revoked" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp with time zone,
	"auth_time" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "observability_destination_health" (
	"destination_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"checked_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observability_destination_health_status_check" CHECK ("observability_destination_health"."status" in ('pending', 'healthy', 'degraded', 'paused'))
);
--> statement-breakpoint
CREATE TABLE "observability_policies" (
	"team_id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observability_policies_revision_check" CHECK ("observability_policies"."revision" > 0)
);
--> statement-breakpoint
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
CREATE TABLE "otlp_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"signal" text NOT NULL,
	"payload_hash" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otlp_batches_signal_check" CHECK ("otlp_batches"."signal" in ('traces', 'logs', 'metrics'))
);
--> statement-breakpoint
CREATE TABLE "project_model_gateway" (
	"project_id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'platform' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_model_gateway_mode_check" CHECK ("project_model_gateway"."mode" in ('platform', 'off'))
);
--> statement-breakpoint
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
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"team_id" text DEFAULT 'team_local' NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"import_kind" text NOT NULL,
	"git_url" text,
	"status" text NOT NULL,
	"deployment_status" text NOT NULL,
	"deletion_status" text,
	"deletion_error" text,
	"source_revision_id" text,
	"release_id" text,
	"deployment_id" text,
	"latest_session_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug"),
	CONSTRAINT "projects_slug_check" CHECK (char_length("projects"."slug") <= 53 and "projects"."slug" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
	CONSTRAINT "projects_deletion_status_check" CHECK ("projects"."deletion_status" is null or "projects"."deletion_status" in ('deleting', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"source_revision_id" text NOT NULL,
	"image_tag" text NOT NULL,
	"observer_contract" integer NOT NULL,
	"summary" jsonb,
	"workflow_world_kind" text NOT NULL,
	"workflow_world_package" text,
	"workflow_world_version" text,
	"workflow_storage_spec" integer,
	"workflow_dispatch_protocol" integer,
	"workflow_enqueue_capability" text NOT NULL,
	"model_gateway_provider" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_targets" (
	"route_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"weight" integer NOT NULL,
	"variant_name" text,
	CONSTRAINT "route_targets_weight_check" CHECK ("route_targets"."weight" between 0 and 10000)
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
CREATE TABLE "schedule_run_sessions" (
	"schedule_run_id" text NOT NULL,
	"session_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"completed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_run_sessions_schedule_run_id_session_id_pk" PRIMARY KEY("schedule_run_id","session_id"),
	CONSTRAINT "schedule_run_sessions_status_check" CHECK ("schedule_run_sessions"."status" in ('running', 'succeeded', 'failed', 'parked'))
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
	"acknowledged_at" timestamp with time zone,
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
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"source_path" text NOT NULL,
	"definition_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_versions_kind_check" CHECK ("schedule_versions"."kind" in ('markdown', 'handler'))
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key" text NOT NULL,
	"kind" text DEFAULT 'secret' NOT NULL,
	"encrypted_value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_kind_check" CHECK ("secrets"."kind" in ('variable', 'secret'))
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
	"experiment_id" text,
	"request_id" text NOT NULL,
	"remote_ip" text,
	"affinity_fingerprint" text,
	"affinity_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"session_node_id" text,
	"telemetry_event_id" text,
	"event_fingerprint" text,
	"observed_deployment_id" text,
	"observed_runtime_instance_id" text,
	"source_sequence" integer,
	"index" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"root_session_id" text NOT NULL,
	"project_id" text NOT NULL,
	"eve_session_id" text NOT NULL,
	"parent_node_id" text,
	"parent_eve_session_id" text,
	"started_deployment_id" text NOT NULL,
	"last_observed_deployment_id" text NOT NULL,
	"started_runtime_instance_id" text,
	"last_observed_runtime_instance_id" text,
	"agent_id" text,
	"agent_name" text,
	"node_id" text,
	"channel_kind" text,
	"model_id" text,
	"observed_model_id" text,
	"eve_version" text,
	"resolution_status" text DEFAULT 'observed' NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"deployment_id" text,
	"eve_session_id" text,
	"root_node_id" text,
	"route_id" text,
	"experiment_id" text,
	"variant_name" text,
	"trigger" text NOT NULL,
	"schedule_id" text,
	"schedule_run_id" text,
	"status" text NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" double precision,
	"usage_reported_steps" integer DEFAULT 0 NOT NULL,
	"usage_missing_steps" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "source_files" (
	"id" text PRIMARY KEY NOT NULL,
	"revision_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"size" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_preflights" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"git_url" text,
	"source_path" text,
	"commit_sha" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"summary" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"credential_host" text,
	"encrypted_token" text,
	"persist_credential" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_preflights_kind_check" CHECK ("source_preflights"."kind" in ('git', 'zip')),
	CONSTRAINT "source_preflights_status_check" CHECK ("source_preflights"."status" in ('queued', 'running', 'completed', 'failed', 'consumed'))
);
--> statement-breakpoint
CREATE TABLE "source_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"commit_sha" text,
	"origin" text,
	"base_commit_sha" text,
	"dirty" boolean,
	"uploaded_by" text,
	"source_path" text NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"env_vars" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_revisions_origin_check" CHECK ("source_revisions"."origin" is null or "source_revisions"."origin" in ('git-sync', 'cli-upload', 'dashboard-upload'))
);
--> statement-breakpoint
CREATE TABLE "team_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memberships_role_check" CHECK ("team_memberships"."role" in ('admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"image" text,
	"display_timezone" text,
	"role" text DEFAULT 'user',
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"interval_ms" integer NOT NULL,
	"last_tick_duration_ms" integer NOT NULL,
	"last_error" text,
	"max_concurrent_heavy_jobs" integer
);
--> statement-breakpoint
CREATE TABLE "workflow_dispatcher_registrations" (
	"instance_id" text PRIMARY KEY NOT NULL,
	"generation" text NOT NULL,
	"state" text NOT NULL,
	"ownership_acquired" boolean NOT NULL,
	"boot_recovery_completed" boolean NOT NULL,
	"reenqueued_runs" integer,
	"world_database_identity" text NOT NULL,
	"schema_generation" text,
	"protocol_min" integer NOT NULL,
	"protocol_max" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activation_leases" ADD CONSTRAINT "activation_leases_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_leases" ADD CONSTRAINT "activation_leases_runtime_instance_id_runtime_instances_id_fk" FOREIGN KEY ("runtime_instance_id") REFERENCES "public"."runtime_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_auth_credentials" ADD CONSTRAINT "agent_auth_credentials_agent_connection_id_agent_connections_id_fk" FOREIGN KEY ("agent_connection_id") REFERENCES "public"."agent_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_auth_transactions" ADD CONSTRAINT "agent_auth_transactions_agent_connection_id_agent_connections_id_fk" FOREIGN KEY ("agent_connection_id") REFERENCES "public"."agent_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_routes" ADD CONSTRAINT "agent_routes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_device_codes" ADD CONSTRAINT "auth_device_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_credentials" ADD CONSTRAINT "git_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_login_transactions" ADD CONSTRAINT "identity_login_transactions_provider_connection_id_identity_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."identity_provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_login_transactions" ADD CONSTRAINT "identity_login_transactions_return_target_id_identity_return_targets_id_fk" FOREIGN KEY ("return_target_id") REFERENCES "public"."identity_return_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_principals" ADD CONSTRAINT "identity_principals_identity_realm_id_identity_realms_id_fk" FOREIGN KEY ("identity_realm_id") REFERENCES "public"."identity_realms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_realms" ADD CONSTRAINT "identity_realms_provider_connection_id_identity_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."identity_provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_identity_principal_id_identity_principals_id_fk" FOREIGN KEY ("identity_principal_id") REFERENCES "public"."identity_principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_active_identity_realm_id_identity_realms_id_fk" FOREIGN KEY ("active_identity_realm_id") REFERENCES "public"."identity_realms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD CONSTRAINT "model_usage_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD CONSTRAINT "model_usage_events_session_node_id_session_nodes_id_fk" FOREIGN KEY ("session_node_id") REFERENCES "public"."session_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observability_policies" ADD CONSTRAINT "observability_policies_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_bindings" ADD CONSTRAINT "operation_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_bindings" ADD CONSTRAINT "operation_bindings_route_id_agent_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."agent_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_bindings" ADD CONSTRAINT "operation_bindings_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_model_gateway" ADD CONSTRAINT "project_model_gateway_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scheduler_targets" ADD CONSTRAINT "project_scheduler_targets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scheduler_targets" ADD CONSTRAINT "project_scheduler_targets_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_schedules" ADD CONSTRAINT "project_schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_source_revision_id_source_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."source_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_targets" ADD CONSTRAINT "route_targets_route_id_agent_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."agent_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_targets" ADD CONSTRAINT "route_targets_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_instances" ADD CONSTRAINT "runtime_instances_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_run_sessions" ADD CONSTRAINT "schedule_run_sessions_schedule_run_id_schedule_runs_id_fk" FOREIGN KEY ("schedule_run_id") REFERENCES "public"."schedule_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_run_sessions" ADD CONSTRAINT "schedule_run_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_project_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."project_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_version_id_schedule_versions_id_fk" FOREIGN KEY ("schedule_version_id") REFERENCES "public"."schedule_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_versions" ADD CONSTRAINT "schedule_versions_schedule_id_project_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."project_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_versions" ADD CONSTRAINT "schedule_versions_source_revision_id_source_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."source_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_bindings" ADD CONSTRAINT "session_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_bindings" ADD CONSTRAINT "session_bindings_route_id_agent_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."agent_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_bindings" ADD CONSTRAINT "session_bindings_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_node_id_session_nodes_id_fk" FOREIGN KEY ("session_node_id") REFERENCES "public"."session_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_observed_deployment_id_deployments_id_fk" FOREIGN KEY ("observed_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_observed_runtime_instance_id_runtime_instances_id_fk" FOREIGN KEY ("observed_runtime_instance_id") REFERENCES "public"."runtime_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD CONSTRAINT "session_nodes_root_session_id_sessions_id_fk" FOREIGN KEY ("root_session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD CONSTRAINT "session_nodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD CONSTRAINT "session_nodes_started_deployment_id_deployments_id_fk" FOREIGN KEY ("started_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD CONSTRAINT "session_nodes_last_observed_deployment_id_deployments_id_fk" FOREIGN KEY ("last_observed_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD CONSTRAINT "session_nodes_started_runtime_instance_id_runtime_instances_id_fk" FOREIGN KEY ("started_runtime_instance_id") REFERENCES "public"."runtime_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_nodes" ADD CONSTRAINT "session_nodes_last_observed_runtime_instance_id_runtime_instances_id_fk" FOREIGN KEY ("last_observed_runtime_instance_id") REFERENCES "public"."runtime_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_route_id_agent_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."agent_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_schedule_run_id_schedule_runs_id_fk" FOREIGN KEY ("schedule_run_id") REFERENCES "public"."schedule_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_revision_id_source_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."source_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_preflights" ADD CONSTRAINT "source_preflights_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activation_leases_deployment_kind_owner_idx" ON "activation_leases" USING btree ("deployment_id","kind","owner_id");--> statement-breakpoint
CREATE INDEX "activation_leases_active_idx" ON "activation_leases" USING btree ("deployment_id","expires_at","released_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_auth_credentials_scope_idx" ON "agent_auth_credentials" USING btree ("agent_connection_id","security_revision","auth_method","credential_scope","scope_subject","credential_key");--> statement-breakpoint
CREATE INDEX "agent_auth_transactions_expires_idx" ON "agent_auth_transactions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_connections_project_idx" ON "agent_connections" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_routes_hostname_idx" ON "agent_routes" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "auth_accounts_user_idx" ON "auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_provider_account_idx" ON "auth_accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_issuer_account_idx" ON "auth_accounts" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_device_codes_device_code_idx" ON "auth_device_codes" USING btree ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_device_codes_user_code_idx" ON "auth_device_codes" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "auth_device_codes_expires_idx" ON "auth_device_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_project_key_idx" ON "deployments" USING btree ("project_id","deployment_key");--> statement-breakpoint
CREATE UNIQUE INDEX "git_credentials_user_host_idx" ON "git_credentials" USING btree ("user_id","host");--> statement-breakpoint
CREATE INDEX "git_credentials_user_idx" ON "git_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "host_metric_samples_worker_observed_idx" ON "host_metric_samples" USING btree ("worker_id","observed_at");--> statement-breakpoint
CREATE INDEX "host_metric_samples_observed_idx" ON "host_metric_samples" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "identity_login_transactions_expiry_idx" ON "identity_login_transactions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "identity_login_transactions_provider_idx" ON "identity_login_transactions" USING btree ("provider_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_principals_realm_subject_idx" ON "identity_principals" USING btree ("identity_realm_id","external_subject");--> statement-breakpoint
CREATE INDEX "identity_principals_realm_idx" ON "identity_principals" USING btree ("identity_realm_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_provider_connections_one_enabled_idx" ON "identity_provider_connections" USING btree ((true)) WHERE "identity_provider_connections"."enabled" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_realms_provider_external_idx" ON "identity_realms" USING btree ("provider_connection_id","external_realm_id");--> statement-breakpoint
CREATE INDEX "identity_realms_provider_idx" ON "identity_realms" USING btree ("provider_connection_id");--> statement-breakpoint
CREATE INDEX "identity_sessions_token_idx" ON "identity_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "identity_sessions_principal_idx" ON "identity_sessions" USING btree ("identity_principal_id");--> statement-breakpoint
CREATE INDEX "identity_sessions_expiry_idx" ON "identity_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_signing_keys_one_active_idx" ON "identity_signing_keys" USING btree ("status") WHERE "identity_signing_keys"."status" = 'active';--> statement-breakpoint
CREATE INDEX "invitations_team_status_idx" ON "invitations" USING btree ("team_id","status");--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "jobs_queued_claim_idx" ON "jobs" USING btree ("created_at","sequence") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_running_project_idx" ON "jobs" USING btree ("project_id","locked_at") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "jobs_project_created_idx" ON "jobs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "logs_project_seq_idx" ON "logs" USING btree ("project_id","seq");--> statement-breakpoint
CREATE INDEX "logs_project_type_seq_idx" ON "logs" USING btree ("project_id","type","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "model_usage_session_eve_run_idx" ON "model_usage_events" USING btree ("session_id","eve_session_id","run_key");--> statement-breakpoint
CREATE UNIQUE INDEX "model_usage_node_run_idx" ON "model_usage_events" USING btree ("session_node_id","run_key");--> statement-breakpoint
CREATE INDEX "model_usage_created_idx" ON "model_usage_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_access_tokens_token_idx" ON "oauth_access_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_client_idx" ON "oauth_access_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_session_idx" ON "oauth_access_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_user_idx" ON "oauth_access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_authorization_code_idx" ON "oauth_access_tokens" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_refresh_idx" ON "oauth_access_tokens" USING btree ("refresh_id");--> statement-breakpoint
CREATE INDEX "oauth_client_resources_client_idx" ON "oauth_client_resources" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_client_resources_resource_idx" ON "oauth_client_resources" USING btree ("resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_client_resources_client_resource_idx" ON "oauth_client_resources" USING btree ("client_id","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_clients_client_id_idx" ON "oauth_clients" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_consents_client_idx" ON "oauth_consents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_consents_user_idx" ON "oauth_consents" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_refresh_tokens_token_idx" ON "oauth_refresh_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_client_idx" ON "oauth_refresh_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_session_idx" ON "oauth_refresh_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_user_idx" ON "oauth_refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_authorization_code_idx" ON "oauth_refresh_tokens" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_resources_identifier_idx" ON "oauth_resources" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "operation_bindings_project_key_idx" ON "operation_bindings" USING btree ("project_id","operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "otlp_batches_signal_hash_idx" ON "otlp_batches" USING btree ("signal","payload_hash");--> statement-breakpoint
CREATE INDEX "otlp_batches_signal_received_idx" ON "otlp_batches" USING btree ("signal","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_schedules_project_key_idx" ON "project_schedules" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "releases_project_idx" ON "releases" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "route_targets_route_deployment_idx" ON "route_targets" USING btree ("route_id","deployment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_instances_deployment_generation_idx" ON "runtime_instances" USING btree ("deployment_id","generation");--> statement-breakpoint
CREATE INDEX "runtime_instances_deployment_status_idx" ON "runtime_instances" USING btree ("deployment_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_instances_live_port_idx" ON "runtime_instances" USING btree ("endpoint_port") WHERE "runtime_instances"."status" in ('starting', 'ready', 'draining') and "runtime_instances"."endpoint_port" is not null;--> statement-breakpoint
CREATE INDEX "schedule_run_sessions_status_idx" ON "schedule_run_sessions" USING btree ("schedule_run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_runs_version_due_idx" ON "schedule_runs" USING btree ("schedule_version_id","due_at") WHERE "schedule_runs"."trigger" = 'cron';--> statement-breakpoint
CREATE INDEX "schedule_runs_schedule_status_idx" ON "schedule_runs" USING btree ("schedule_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_versions_schedule_revision_idx" ON "schedule_versions" USING btree ("schedule_id","source_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_project_key_idx" ON "secrets" USING btree ("project_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "session_bindings_project_eve_idx" ON "session_bindings" USING btree ("project_id","eve_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_node_telemetry_idx" ON "session_events" USING btree ("session_node_id","telemetry_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_node_fingerprint_idx" ON "session_events" USING btree ("session_node_id","event_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_session_index_idx" ON "session_events" USING btree ("session_id","index");--> statement-breakpoint
CREATE UNIQUE INDEX "session_nodes_project_eve_idx" ON "session_nodes" USING btree ("project_id","eve_session_id");--> statement-breakpoint
CREATE INDEX "session_nodes_project_model_idx" ON "session_nodes" USING btree ("project_id","model_id");--> statement-breakpoint
CREATE INDEX "session_nodes_root_session_idx" ON "session_nodes" USING btree ("root_session_id","created_at");--> statement-breakpoint
CREATE INDEX "session_nodes_last_runtime_idx" ON "session_nodes" USING btree ("last_observed_runtime_instance_id","status");--> statement-breakpoint
CREATE INDEX "sessions_schedule_run_idx" ON "sessions" USING btree ("schedule_run_id");--> statement-breakpoint
CREATE INDEX "sessions_project_started_idx" ON "sessions" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_project_eve_session_idx" ON "sessions" USING btree ("project_id","eve_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_files_revision_path_idx" ON "source_files" USING btree ("revision_id","path");--> statement-breakpoint
CREATE INDEX "source_preflights_user_idx" ON "source_preflights" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "source_preflights_queue_idx" ON "source_preflights" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "source_preflights_expiry_idx" ON "source_preflights" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "team_memberships_user_idx" ON "team_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "team_memberships_team_idx" ON "team_memberships" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_memberships_team_user_idx" ON "team_memberships" USING btree ("team_id","user_id");--> statement-breakpoint
-- Seed rows the platform cannot run without and schema.ts cannot express.
-- The single Team every member, Project, and observability policy belongs to
-- (DEFAULT_TEAM_ID in store-shared.ts, the Better Auth organization id).
INSERT INTO "teams" ("id", "name", "slug") VALUES ('team_local', 'Eveland', 'eveland');--> statement-breakpoint
-- Open access is the platform's default Identity Provider, with the single
-- shared Realm every caller it admits belongs to.
INSERT INTO "identity_provider_connections" (
  "id", "type", "display_name", "scopes", "authorization_parameters",
  "external_realm_resolution", "enabled", "security_revision"
) VALUES (
  'idpc_openaccess', 'open', 'Open for all', '[]'::jsonb, '{}'::jsonb,
  'open_shared', true, 1
);--> statement-breakpoint
INSERT INTO "identity_realms" (
  "id", "provider_connection_id", "external_realm_id", "external_realm_kind",
  "display_name", "enabled"
) VALUES (
  'irlm_openshared', 'idpc_openaccess', 'open-shared', 'internal', 'Open access', true
);