CREATE TABLE "otlp_log_records" (
	"id" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"trace_id" text,
	"span_id" text,
	"service_name" text NOT NULL,
	"domain" text NOT NULL,
	"project_id" text,
	"deployment_id" text,
	"timestamp" timestamp with time zone NOT NULL,
	"observed_timestamp" timestamp with time zone,
	"severity_number" integer,
	"severity_text" text,
	"event_name" text,
	"scope_name" text,
	"body" jsonb NOT NULL,
	"attributes" jsonb NOT NULL,
	"resource_attributes" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otlp_log_records_domain_check" CHECK ("otlp_log_records"."domain" in ('agent', 'platform', 'runtime', 'capacity'))
);
--> statement-breakpoint
CREATE TABLE "otlp_spans" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"service_name" text NOT NULL,
	"domain" text NOT NULL,
	"project_id" text,
	"deployment_id" text,
	"name" text NOT NULL,
	"kind" integer,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"duration_ms" double precision NOT NULL,
	"status_code" integer,
	"status_message" text,
	"scope_name" text,
	"attributes" jsonb NOT NULL,
	"resource_attributes" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otlp_spans_domain_check" CHECK ("otlp_spans"."domain" in ('agent', 'platform', 'runtime', 'capacity'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "otlp_log_records_fingerprint_idx" ON "otlp_log_records" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "otlp_log_records_timestamp_idx" ON "otlp_log_records" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "otlp_log_records_domain_timestamp_idx" ON "otlp_log_records" USING btree ("domain","timestamp");--> statement-breakpoint
CREATE INDEX "otlp_log_records_service_timestamp_idx" ON "otlp_log_records" USING btree ("service_name","timestamp");--> statement-breakpoint
CREATE INDEX "otlp_log_records_project_timestamp_idx" ON "otlp_log_records" USING btree ("project_id","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "otlp_spans_trace_span_idx" ON "otlp_spans" USING btree ("trace_id","span_id");--> statement-breakpoint
CREATE INDEX "otlp_spans_started_idx" ON "otlp_spans" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "otlp_spans_domain_started_idx" ON "otlp_spans" USING btree ("domain","started_at");--> statement-breakpoint
CREATE INDEX "otlp_spans_service_started_idx" ON "otlp_spans" USING btree ("service_name","started_at");--> statement-breakpoint
CREATE INDEX "otlp_spans_project_started_idx" ON "otlp_spans" USING btree ("project_id","started_at");