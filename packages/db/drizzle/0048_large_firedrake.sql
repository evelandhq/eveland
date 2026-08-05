-- Adds the `open` Identity Provider type and makes the enabled Provider
-- platform-wide exclusive.
--
-- The DDL below is what `drizzle-kit generate` produced; the data steps and
-- the statement order are hand written. The generated order created the unique
-- index before reconciling the rows it constrains, which fails on any instance
-- that already has more than one enabled Provider.
--
-- Rolling back to a release before this migration leaves the `open` row and the
-- widened constraints in place; that release's code reads `type = 'open'` as an
-- unknown Provider and `/identity/login` answers 503. To restore the previous
-- contract by hand, in one transaction:
--
--   delete from identity_provider_connections where type = 'open';
--   -- then re-enable the Provider that instance used to run, if any
--   alter table identity_provider_connections
--     drop constraint identity_provider_connections_type_check,
--     add constraint identity_provider_connections_type_check
--       check (type in ('internal', 'oidc'));
--   drop index identity_provider_connections_one_enabled_idx;
--   create unique index identity_provider_connections_one_enabled_internal_idx
--     on identity_provider_connections (type)
--     where type = 'internal' and enabled = true;
--
-- The shape_check branch for `open` is harmless to leave in place once no
-- `open` rows remain. Providers this migration disabled to resolve a
-- multi-enabled instance are not restored automatically.

-- An instance can already carry one enabled internal Provider alongside one
-- enabled OIDC Provider: the old index only constrained internal, and the API
-- only pre-checked internal. `/identity/login` answers 503 in that state, so
-- nothing worked there anyway -- but the unique index below cannot be created
-- over it. Keep exactly one, preferring the internal Provider (the only type
-- with a working login path today) and otherwise the oldest.
UPDATE "identity_provider_connections"
SET "enabled" = false, "updated_at" = now()
WHERE "enabled" = true
  AND "id" <> (
    SELECT "id" FROM "identity_provider_connections"
    WHERE "enabled" = true
    ORDER BY ("type" = 'internal') DESC, "created_at" ASC, "id" ASC
    LIMIT 1
  );--> statement-breakpoint
ALTER TABLE "identity_provider_connections" DROP CONSTRAINT "identity_provider_connections_type_check";--> statement-breakpoint
ALTER TABLE "identity_provider_connections" DROP CONSTRAINT "identity_provider_connections_shape_check";--> statement-breakpoint
ALTER TABLE "identity_provider_connections" ADD CONSTRAINT "identity_provider_connections_type_check" CHECK ("identity_provider_connections"."type" in ('internal', 'oidc', 'open'));--> statement-breakpoint
ALTER TABLE "identity_provider_connections" ADD CONSTRAINT "identity_provider_connections_shape_check" CHECK ((
        "identity_provider_connections"."type" = 'open'
        and "identity_provider_connections"."internal_realm_key" is null
        and "identity_provider_connections"."issuer" is null
        and "identity_provider_connections"."client_id" is null
      ) or (
        "identity_provider_connections"."type" = 'internal'
        and "identity_provider_connections"."internal_realm_key" is not null
        and "identity_provider_connections"."issuer" is null
        and "identity_provider_connections"."client_id" is null
      ) or (
        "identity_provider_connections"."type" = 'oidc'
        and "identity_provider_connections"."internal_realm_key" is null
        and "identity_provider_connections"."issuer" is not null
        and "identity_provider_connections"."client_id" is not null
        and "identity_provider_connections"."token_endpoint_auth_method" in ('client_secret_basic', 'client_secret_post', 'none')
      ));--> statement-breakpoint
-- Seed open access as the platform default, but only where no Provider is
-- already enabled: an instance that has switched on Eveland Internal keeps it
-- and stays untouched until an administrator switches deliberately.
INSERT INTO "identity_provider_connections" (
  "id", "type", "display_name", "internal_realm_key", "issuer", "client_id",
  "client_secret_encrypted", "scopes", "authorization_parameters",
  "token_endpoint_auth_method", "external_realm_resolution",
  "external_realm_claim", "enabled", "security_revision"
)
SELECT
  'idpc_openaccess', 'open', 'Open for all', NULL, NULL, NULL,
  NULL, '[]'::jsonb, '{}'::jsonb,
  NULL, 'open_shared',
  NULL, true, 1
WHERE NOT EXISTS (
  SELECT 1 FROM "identity_provider_connections" WHERE "enabled" = true
);--> statement-breakpoint
-- The open Provider's single shared Realm. Open access carries no per-caller
-- identity, so every caller it admits belongs to this one Realm.
INSERT INTO "identity_realms" (
  "id", "provider_connection_id", "external_realm_id", "external_realm_kind",
  "display_name", "enabled"
)
SELECT
  'irlm_openshared', 'idpc_openaccess', 'open-shared', 'internal',
  'Open access', true
WHERE EXISTS (
  SELECT 1 FROM "identity_provider_connections" WHERE "id" = 'idpc_openaccess'
);--> statement-breakpoint
DROP INDEX "identity_provider_connections_one_enabled_internal_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "identity_provider_connections_one_enabled_idx" ON "identity_provider_connections" USING btree ((true)) WHERE "identity_provider_connections"."enabled" = true;
