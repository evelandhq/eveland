CREATE TABLE "workflow_cutover_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"phase" text NOT NULL,
	"scope" jsonb NOT NULL,
	"checkpoints" jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_fences" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_fences_scope_idx" ON "workflow_fences" USING btree ("scope_kind","scope_id");