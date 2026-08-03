ALTER TABLE "host_metric_samples" ADD COLUMN "cpu_cores" integer;--> statement-breakpoint
ALTER TABLE "host_metric_samples" ADD COLUMN "pg_connections" jsonb;