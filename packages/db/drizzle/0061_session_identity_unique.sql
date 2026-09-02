-- Fold Sessions that already share (project_id, eve_session_id) before the pair
-- becomes unique. The rules mirror mergeSessionRows (postgres-store-support.ts):
-- the older row survives; the newer row's nodes, events (renumbered after the
-- survivor's), and usage rows move onto it, usage counters are summed, metadata
-- gaps are filled from the absorbed row, and the absorbed row is deleted.
-- ScheduleRun links additionally carry over so a scheduled Session absorbed by
-- an observed placeholder keeps its run. Folding cannot decide between two
-- copies of the same model usage step, so that case refuses with the query the
-- operator needs.
DO $$
DECLARE
  duplicate record;
  keeper record;
  absorbed record;
  next_index integer;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "sessions" older
    JOIN "sessions" newer
      ON newer."project_id" = older."project_id"
     AND newer."eve_session_id" = older."eve_session_id"
     AND (newer."started_at", newer."id") > (older."started_at", older."id")
    JOIN "model_usage_events" older_usage ON older_usage."session_id" = older."id"
    JOIN "model_usage_events" newer_usage
      ON newer_usage."session_id" = newer."id"
     AND newer_usage."eve_session_id" = older_usage."eve_session_id"
     AND newer_usage."turn_id" = older_usage."turn_id"
     AND newer_usage."step_index" = older_usage."step_index"
    WHERE older."eve_session_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'migration 0061 cannot fold Sessions that share (project_id, eve_session_id): both rows carry the same model usage step, so folding would double count usage'
      USING HINT = 'List them with: SELECT older.id AS older_session, newer.id AS newer_session, u.eve_session_id, u.turn_id, u.step_index FROM sessions older JOIN sessions newer ON newer.project_id = older.project_id AND newer.eve_session_id = older.eve_session_id AND (newer.started_at, newer.id) > (older.started_at, older.id) JOIN model_usage_events u ON u.session_id = older.id JOIN model_usage_events n ON n.session_id = newer.id AND n.eve_session_id = u.eve_session_id AND n.turn_id = u.turn_id AND n.step_index = u.step_index WHERE older.eve_session_id IS NOT NULL; then delete the newer Session''s duplicated usage rows (or the newer Session) and re-run the migration.';
  END IF;

  FOR duplicate IN
    SELECT "project_id", "eve_session_id"
    FROM "sessions"
    WHERE "eve_session_id" IS NOT NULL
    GROUP BY "project_id", "eve_session_id"
    HAVING count(*) > 1
  LOOP
    SELECT * INTO keeper
    FROM "sessions"
    WHERE "project_id" = duplicate."project_id" AND "eve_session_id" = duplicate."eve_session_id"
    ORDER BY "started_at", "id"
    LIMIT 1;

    FOR absorbed IN
      SELECT *
      FROM "sessions"
      WHERE "project_id" = duplicate."project_id"
        AND "eve_session_id" = duplicate."eve_session_id"
        AND "id" <> keeper."id"
      ORDER BY "started_at", "id"
    LOOP
      UPDATE "session_nodes" SET "root_session_id" = keeper."id" WHERE "root_session_id" = absorbed."id";

      SELECT coalesce(max("index") + 1, 0) INTO next_index
      FROM "session_events" WHERE "session_id" = keeper."id";
      UPDATE "session_events"
      SET "session_id" = keeper."id", "index" = "index" + next_index
      WHERE "session_id" = absorbed."id";

      UPDATE "model_usage_events" SET "session_id" = keeper."id" WHERE "session_id" = absorbed."id";

      UPDATE "schedule_run_sessions" link
      SET "session_id" = keeper."id"
      WHERE link."session_id" = absorbed."id"
        AND NOT EXISTS (
          SELECT 1 FROM "schedule_run_sessions" kept
          WHERE kept."session_id" = keeper."id" AND kept."schedule_run_id" = link."schedule_run_id"
        );

      UPDATE "sessions"
      SET "root_node_id" = coalesce("root_node_id", absorbed."root_node_id"),
          "deployment_id" = coalesce("deployment_id", absorbed."deployment_id"),
          "route_id" = coalesce("route_id", absorbed."route_id"),
          "experiment_id" = coalesce("experiment_id", absorbed."experiment_id"),
          "variant_name" = coalesce("variant_name", absorbed."variant_name"),
          "schedule_id" = coalesce("schedule_id", absorbed."schedule_id"),
          "schedule_run_id" = coalesce("schedule_run_id", absorbed."schedule_run_id"),
          "trigger" = CASE WHEN "trigger" = 'direct_http' THEN absorbed."trigger" ELSE "trigger" END,
          "input_tokens" = "input_tokens" + absorbed."input_tokens",
          "output_tokens" = "output_tokens" + absorbed."output_tokens",
          "cache_read_tokens" = "cache_read_tokens" + absorbed."cache_read_tokens",
          "cache_write_tokens" = "cache_write_tokens" + absorbed."cache_write_tokens",
          "cost_usd" = CASE
            WHEN absorbed."cost_usd" IS NULL THEN "cost_usd"
            ELSE coalesce("cost_usd", 0) + absorbed."cost_usd"
          END,
          "usage_reported_steps" = "usage_reported_steps" + absorbed."usage_reported_steps",
          "usage_missing_steps" = "usage_missing_steps" + absorbed."usage_missing_steps"
      WHERE "id" = keeper."id";

      DELETE FROM "sessions" WHERE "id" = absorbed."id";
    END LOOP;
  END LOOP;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "sessions_project_eve_session_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_project_eve_session_idx" ON "sessions" USING btree ("project_id","eve_session_id");
