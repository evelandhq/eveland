UPDATE "source_revisions" AS "revision"
SET "summary" = jsonb_set(
	"revision"."summary",
	'{capabilities}',
	(
		CASE
			WHEN jsonb_typeof("revision"."summary"->'capabilities') = 'object'
				THEN "revision"."summary"->'capabilities'
			ELSE '{}'::jsonb
		END
	) || '{"eveChat":true}'::jsonb,
	true
)
WHERE "revision"."summary"#>'{capabilities,eveChat}' IS NULL
AND EXISTS (
	SELECT 1
	FROM "source_files" AS "file"
	WHERE "file"."revision_id" = "revision"."id"
	AND "file"."path" ~ '^(agent/)?channels/eve\.([cm]?[jt]s)$'
	AND "file"."content" ~ 'import[[:space:]]*\{[^}]*\meveChannel\M[^}]*\}[[:space:]]*from[[:space:]]*["'']eve/channels/eve["'']'
	AND "file"."content" ~ 'export[[:space:]]+default[[:space:]]+eveChannel[[:space:]]*\('
);
