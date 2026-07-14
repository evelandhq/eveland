ALTER TABLE "projects" RENAME COLUMN "routing_key" TO "slug";--> statement-breakpoint
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_deployment_key_unique";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_routing_key_unique";--> statement-breakpoint
DO $$
DECLARE
  project RECORD;
  base text;
  candidate text;
  suffix integer;
  suffix_text text;
BEGIN
  FOR project IN SELECT "id", "name" FROM "projects" ORDER BY "created_at", "id" LOOP
    base := trim(both '-' from lower(regexp_replace(project."name", '[^a-zA-Z0-9]+', '-', 'g')));
    IF base = '' THEN
      base := 'project';
    END IF;
    base := trim(trailing '-' from left(base, 53));
    candidate := base;
    suffix := 0;
    WHILE EXISTS (
      SELECT 1 FROM "projects" AS existing
      WHERE existing."id" <> project."id" AND existing."slug" = candidate
    ) LOOP
      suffix := suffix + 1;
      suffix_text := '-' || suffix::text;
      candidate := trim(trailing '-' from left(base, 53 - char_length(suffix_text))) || suffix_text;
    END LOOP;
    UPDATE "projects" SET "slug" = candidate, "name" = candidate WHERE "id" = project."id";
  END LOOP;
END $$;--> statement-breakpoint
DO $$
DECLARE
  deployment RECORD;
  candidate text;
  salt integer;
BEGIN
  FOR deployment IN SELECT "id", "project_id" FROM "deployments" ORDER BY "created_at", "id" LOOP
    salt := 0;
    candidate := substring(md5(deployment."id" || salt::text), 1, 8);
    WHILE EXISTS (
      SELECT 1 FROM "deployments" AS existing
      WHERE existing."id" <> deployment."id"
        AND existing."project_id" = deployment."project_id"
        AND existing."deployment_key" = candidate
    ) LOOP
      salt := salt + 1;
      candidate := substring(md5(deployment."id" || salt::text), 1, 8);
    END LOOP;
    UPDATE "deployments" SET "deployment_key" = candidate WHERE "id" = deployment."id";
  END LOOP;
END $$;--> statement-breakpoint
UPDATE "agent_routes" AS route
SET "hostname" = project."slug" || substring(route."hostname" from position('.' in route."hostname"))
FROM "projects" AS project
WHERE route."project_id" = project."id" AND route."kind" = 'project';--> statement-breakpoint
UPDATE "agent_routes" AS route
SET "hostname" = split_part(split_part(route."hostname", '.', 1), '--', 1)
  || '--' || project."slug"
  || substring(route."hostname" from position('.' in route."hostname"))
FROM "projects" AS project
WHERE route."project_id" = project."id" AND route."kind" = 'alias';--> statement-breakpoint
UPDATE "agent_routes" AS route
SET "hostname" = deployment."deployment_key" || '--' || project."slug"
  || substring(route."hostname" from position('.' in route."hostname"))
FROM "projects" AS project, "route_targets" AS target, "deployments" AS deployment
WHERE route."project_id" = project."id"
  AND route."kind" = 'deployment'
  AND target."route_id" = route."id"
  AND deployment."id" = target."deployment_id";--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_project_key_idx" ON "deployments" USING btree ("project_id","deployment_key");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_slug_unique" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_key_check" CHECK ("deployments"."deployment_key" ~ '^[a-z0-9]{8}$');--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_slug_check" CHECK (char_length("projects"."slug") <= 53 and "projects"."slug" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$');
