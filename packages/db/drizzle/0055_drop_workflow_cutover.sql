DROP TABLE "workflow_cutover_operations" CASCADE;--> statement-breakpoint
DROP TABLE "workflow_fences" CASCADE;--> statement-breakpoint
ALTER TABLE "deployments" DROP COLUMN "workflow_runner_mode";--> statement-breakpoint
ALTER TABLE "deployments" DROP COLUMN "workflow_conversion_state";--> statement-breakpoint
ALTER TABLE "deployments" DROP COLUMN "workflow_conversion_operation_id";--> statement-breakpoint
ALTER TABLE "deployments" DROP COLUMN "workflow_runner_evidence";--> statement-breakpoint
ALTER TABLE "deployments" DROP COLUMN "workflow_converted_at";--> statement-breakpoint
ALTER TABLE "workflow_dispatcher_registrations" DROP COLUMN "cutover_operation_id";--> statement-breakpoint
ALTER TABLE "workflow_dispatcher_registrations" DROP COLUMN "unscoped_runnable_jobs";--> statement-breakpoint
ALTER TABLE "workflow_dispatcher_registrations" DROP COLUMN "unresolved_quarantines";--> statement-breakpoint
ALTER TABLE "workflow_dispatcher_registrations" DROP COLUMN "desired_state";