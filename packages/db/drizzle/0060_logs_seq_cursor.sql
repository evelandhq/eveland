DROP INDEX "logs_project_created_idx";--> statement-breakpoint
ALTER TABLE "logs" ADD COLUMN "seq" bigint;--> statement-breakpoint
CREATE SEQUENCE "logs_seq_seq" OWNED BY "logs"."seq";--> statement-breakpoint
WITH "ordered" AS (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS "rn" FROM "logs") UPDATE "logs" SET "seq" = "ordered"."rn" FROM "ordered" WHERE "logs"."id" = "ordered"."id";--> statement-breakpoint
SELECT setval('logs_seq_seq', (SELECT coalesce(max("seq"), 0) + 1 FROM "logs"), false);--> statement-breakpoint
ALTER TABLE "logs" ALTER COLUMN "seq" SET DEFAULT nextval('logs_seq_seq');--> statement-breakpoint
ALTER TABLE "logs" ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "logs_project_seq_idx" ON "logs" USING btree ("project_id","seq");--> statement-breakpoint
CREATE INDEX "logs_project_type_seq_idx" ON "logs" USING btree ("project_id","type","seq");
