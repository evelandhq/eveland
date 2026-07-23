CREATE TABLE "otlp_metric_points" (
	"id" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"service_name" text NOT NULL,
	"domain" text NOT NULL,
	"project_id" text,
	"deployment_id" text,
	"name" text NOT NULL,
	"description" text,
	"unit" text,
	"data_type" text NOT NULL,
	"aggregation_temporality" integer,
	"monotonic" boolean,
	"start_timestamp" timestamp with time zone,
	"timestamp" timestamp with time zone NOT NULL,
	"scope_name" text,
	"attributes" jsonb NOT NULL,
	"value" jsonb NOT NULL,
	"resource_attributes" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otlp_metric_points_domain_check" CHECK ("otlp_metric_points"."domain" in ('agent', 'platform', 'runtime', 'capacity')),
	CONSTRAINT "otlp_metric_points_data_type_check" CHECK ("otlp_metric_points"."data_type" in ('gauge', 'sum', 'histogram', 'exponential_histogram', 'summary'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "otlp_metric_points_fingerprint_idx" ON "otlp_metric_points" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "otlp_metric_points_timestamp_idx" ON "otlp_metric_points" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "otlp_metric_points_name_timestamp_idx" ON "otlp_metric_points" USING btree ("name","timestamp");--> statement-breakpoint
CREATE INDEX "otlp_metric_points_domain_timestamp_idx" ON "otlp_metric_points" USING btree ("domain","timestamp");--> statement-breakpoint
CREATE INDEX "otlp_metric_points_service_timestamp_idx" ON "otlp_metric_points" USING btree ("service_name","timestamp");--> statement-breakpoint
CREATE INDEX "otlp_metric_points_project_timestamp_idx" ON "otlp_metric_points" USING btree ("project_id","timestamp");