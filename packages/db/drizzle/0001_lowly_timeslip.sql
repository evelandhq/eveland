CREATE TABLE "source_files" (
	"id" text PRIMARY KEY NOT NULL,
	"revision_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"size" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"commit_sha" text,
	"source_path" text NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"env_vars" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_revision_id_source_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."source_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_files_revision_path_idx" ON "source_files" USING btree ("revision_id","path");