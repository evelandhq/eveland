ALTER TABLE "identity_oidc_credentials" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "identity_oidc_credentials" CASCADE;--> statement-breakpoint
-- A Release with no recorded observer contract predates contract 1; record it
-- as 0 so activation keeps reporting it as stale.
UPDATE "releases" SET "observer_contract" = 0 WHERE "observer_contract" IS NULL;--> statement-breakpoint
ALTER TABLE "releases" ALTER COLUMN "observer_contract" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_run_sessions" DROP COLUMN "last_observed_at";
