-- Existing rows were numbered from a count(*) read, so concurrent appends
-- could assign the same index twice. Renumber only the Sessions that actually
-- contain a duplicate, rebuilding a consistent order from the best available
-- chronology (event time, then insert time, then id as a stable tiebreaker).
WITH renumbered AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "session_id"
      ORDER BY "event_at", "created_at", "id"
    ) - 1 AS "next_index"
  FROM "session_events"
  WHERE "session_id" IN (
    SELECT "session_id"
    FROM "session_events"
    GROUP BY "session_id", "index"
    HAVING count(*) > 1
  )
)
UPDATE "session_events" AS "event"
SET "index" = "renumbered"."next_index"
FROM "renumbered"
WHERE "event"."id" = "renumbered"."id"
  AND "event"."index" IS DISTINCT FROM "renumbered"."next_index";
--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_session_index_idx" ON "session_events" USING btree ("session_id","index");
