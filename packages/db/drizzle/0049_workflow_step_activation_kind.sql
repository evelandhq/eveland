-- The workflow dispatcher holds an activation lease for the duration of one
-- step. Without this value the lease insert fails the check constraint and no
-- step can ever be dispatched.
ALTER TABLE "activation_leases" DROP CONSTRAINT "activation_leases_kind_check";--> statement-breakpoint
ALTER TABLE "activation_leases" ADD CONSTRAINT "activation_leases_kind_check" CHECK ("activation_leases"."kind" in ('public_request', 'stream', 'turn', 'schedule_run', 'workflow_step'));
