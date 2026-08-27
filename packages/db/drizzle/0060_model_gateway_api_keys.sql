CREATE TABLE "model_gateway_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "model_gateway_api_keys" ADD CONSTRAINT "model_gateway_api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_gateway_api_keys_token_hash_idx" ON "model_gateway_api_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "model_gateway_api_keys_user_idx" ON "model_gateway_api_keys" USING btree ("user_id");