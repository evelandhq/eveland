CREATE TABLE "host_metric_samples" (
	"id" text PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"cpu_percent" double precision,
	"load_1" double precision NOT NULL,
	"memory_total_bytes" bigint NOT NULL,
	"memory_available_bytes" bigint NOT NULL,
	"disk_total_bytes" bigint NOT NULL,
	"disk_available_bytes" bigint NOT NULL,
	"disk_inodes_total" bigint,
	"disk_inodes_available" bigint
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"interval_ms" integer NOT NULL,
	"last_tick_duration_ms" integer NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX "host_metric_samples_worker_observed_idx" ON "host_metric_samples" USING btree ("worker_id","observed_at");--> statement-breakpoint
CREATE INDEX "host_metric_samples_observed_idx" ON "host_metric_samples" USING btree ("observed_at");