CREATE TABLE "model_usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"eve_session_id" text NOT NULL,
	"agent_id" text,
	"agent_name" text,
	"turn_id" text NOT NULL,
	"step_index" integer NOT NULL,
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
ALTER TABLE "sessions" ADD COLUMN "input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "output_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "cache_read_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "cache_write_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "cost_usd" double precision;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "usage_reported_steps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "usage_missing_steps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD CONSTRAINT "model_usage_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_usage_session_eve_turn_step_idx" ON "model_usage_events" USING btree ("session_id","eve_session_id","turn_id","step_index");