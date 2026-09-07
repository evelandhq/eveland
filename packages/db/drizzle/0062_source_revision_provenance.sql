ALTER TABLE "source_revisions" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD COLUMN "base_commit_sha" text;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD COLUMN "dirty" boolean;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD COLUMN "uploaded_by" text;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_origin_check" CHECK ("source_revisions"."origin" is null or "source_revisions"."origin" in ('git-sync', 'cli-upload', 'dashboard-upload'));