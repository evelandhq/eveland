DROP INDEX "session_bindings_project_continuation_idx";--> statement-breakpoint
ALTER TABLE "session_bindings" DROP COLUMN "continuation_token";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "continuation_token";