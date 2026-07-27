ALTER TABLE "session_bindings" ADD COLUMN "continuation_token" text;--> statement-breakpoint
WITH "continuation_candidates" AS (
  SELECT
    "session_bindings"."id" AS "binding_id",
    "sessions"."continuation_token",
    row_number() OVER (
      PARTITION BY "session_bindings"."project_id", "sessions"."continuation_token"
      ORDER BY "sessions"."started_at" DESC, "session_bindings"."updated_at" DESC
    ) AS "owner_rank"
  FROM "session_bindings"
  INNER JOIN "sessions"
    ON "sessions"."project_id" = "session_bindings"."project_id"
    AND "sessions"."eve_session_id" = "session_bindings"."eve_session_id"
  WHERE "sessions"."continuation_token" IS NOT NULL
)
UPDATE "session_bindings"
SET "continuation_token" = "continuation_candidates"."continuation_token"
FROM "continuation_candidates"
WHERE "session_bindings"."id" = "continuation_candidates"."binding_id"
  AND "continuation_candidates"."owner_rank" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX "session_bindings_project_continuation_idx" ON "session_bindings" USING btree ("project_id","continuation_token") WHERE "session_bindings"."continuation_token" is not null;
