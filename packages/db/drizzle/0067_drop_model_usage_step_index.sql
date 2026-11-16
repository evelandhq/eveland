DROP INDEX "model_usage_session_eve_turn_step_idx";--> statement-breakpoint
DROP INDEX "model_usage_node_turn_step_idx";--> statement-breakpoint
ALTER TABLE "model_usage_events" DROP COLUMN "step_index";