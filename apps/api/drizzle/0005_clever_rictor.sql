ALTER TABLE "projects" ADD COLUMN "slug" text;--> statement-breakpoint
WITH ranked_projects AS (
  SELECT
    "id",
    coalesce(nullif(trim(both '-' from regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')), ''), 'agent') AS base,
    row_number() over (order by "created_at", "id") AS slug_number,
    greatest(12, length(count(*) over ()::text)) AS suffix_width
  FROM "projects"
  WHERE "slug" IS NULL
),
backfilled_slugs AS (
  SELECT
    "id",
    concat(
      trim(trailing '-' from left(base, greatest(1, 63 - 1 - suffix_width))),
      '-',
      lpad(slug_number::text, suffix_width, '0')
    ) AS slug
  FROM ranked_projects
)
UPDATE "projects"
SET "slug" = backfilled_slugs.slug
FROM backfilled_slugs
WHERE "projects"."id" = backfilled_slugs."id" AND "projects"."slug" IS NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_idx" ON "projects" USING btree ("slug");
