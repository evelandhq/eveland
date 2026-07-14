ALTER TABLE "projects" ADD COLUMN "deletion_status" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deletion_error" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_deletion_status_check" CHECK ("projects"."deletion_status" is null or "projects"."deletion_status" in ('deleting', 'failed'));