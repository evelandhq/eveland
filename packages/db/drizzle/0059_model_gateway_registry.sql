CREATE TABLE "model_gateway_model_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider_model_id" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_gateway_provider_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_gateway_registry_events" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_gateway_model_routes" ADD CONSTRAINT "model_gateway_model_routes_connection_id_model_gateway_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."model_gateway_provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_gateway_model_routes_model_id_idx" ON "model_gateway_model_routes" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "model_gateway_model_routes_connection_idx" ON "model_gateway_model_routes" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_gateway_provider_id_idx" ON "model_gateway_provider_connections" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "model_gateway_registry_events_created_idx" ON "model_gateway_registry_events" USING btree ("created_at");