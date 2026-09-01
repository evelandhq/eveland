ALTER TABLE "logs" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "logs_project_seq_idx" ON "logs" USING btree ("project_id","seq");