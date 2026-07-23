CREATE TABLE "observability_policies" (
	"team_id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observability_policies_revision_check" CHECK ("observability_policies"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "observability_policies" ADD CONSTRAINT "observability_policies_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;