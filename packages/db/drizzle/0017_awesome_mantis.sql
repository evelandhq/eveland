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
ALTER TABLE "source_preflights" ADD CONSTRAINT "source_preflights_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_preflights_user_idx" ON "source_preflights" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "source_preflights_queue_idx" ON "source_preflights" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "source_preflights_expiry_idx" ON "source_preflights" USING btree ("expires_at");