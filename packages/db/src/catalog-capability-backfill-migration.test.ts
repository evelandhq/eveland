import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "vitest";

describe("Agent Catalog capability backfill migration", () => {
  test("backfills only legacy canonical Eve channel revisions and preserves existing metadata", async () => {
    const migrationsDirectory = fileURLToPath(new URL("../drizzle", import.meta.url));
    const migrationFile = readdirSync(migrationsDirectory).find((file) =>
      /^\d{4}_agent_catalog_capability_backfill\.sql$/.test(file),
    );
    expect(migrationFile, "expected an Agent Catalog capability backfill migration").toBeDefined();
    if (!migrationFile) return;

    const migration = readFileSync(`${migrationsDirectory}/${migrationFile}`, "utf8");
    const client = new PGlite();
    try {
      await client.exec(`
        CREATE TABLE source_revisions (
          id text PRIMARY KEY,
          summary jsonb NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE TABLE source_files (
          revision_id text NOT NULL,
          path text NOT NULL,
          content text NOT NULL
        );
      `);
      await seedRevision(client, {
        id: "src_nested",
        summary: {
          summary: { agents: ["agent/agent.ts"] },
          capabilities: { schedules: true },
        },
        path: "agent/channels/eve.ts",
        content: `
          import { eveChannel } from "eve/channels/eve";
          export default eveChannel({});
        `,
      });
      await seedRevision(client, {
        id: "src_flat",
        summary: { summary: { agents: ["agent.ts"] } },
        path: "channels/eve.mts",
        content: `
          import { localDev, eveChannel as ignored } from "eve/channels/auth";
          import { eveChannel } from 'eve/channels/eve';
          export default eveChannel({ auth: localDev() });
        `,
      });
      await seedRevision(client, {
        id: "src_explicit_false",
        summary: {
          capabilities: { eveChat: false, schedules: true },
        },
        path: "agent/channels/eve.ts",
        content: `
          import { eveChannel } from "eve/channels/eve";
          export default eveChannel({});
        `,
      });
      await seedRevision(client, {
        id: "src_wrong_export",
        summary: {},
        path: "agent/channels/eve.ts",
        content: `
          import { eveChannel } from "eve/channels/eve";
          export default customChannel({});
        `,
      });
      await seedRevision(client, {
        id: "src_wrong_path",
        summary: {},
        path: "src/channels/eve.ts",
        content: `
          import { eveChannel } from "eve/channels/eve";
          export default eveChannel({});
        `,
      });

      await client.exec(migration);
      await client.exec(migration);

      const result = await client.query<{
        id: string;
        summary: Record<string, unknown>;
      }>("SELECT id, summary FROM source_revisions ORDER BY id");

      expect(result.rows).toEqual([
        {
          id: "src_explicit_false",
          summary: {
            capabilities: { eveChat: false, schedules: true },
          },
        },
        {
          id: "src_flat",
          summary: {
            capabilities: { eveChat: true },
            summary: { agents: ["agent.ts"] },
          },
        },
        {
          id: "src_nested",
          summary: {
            capabilities: { eveChat: true, schedules: true },
            summary: { agents: ["agent/agent.ts"] },
          },
        },
        { id: "src_wrong_export", summary: {} },
        { id: "src_wrong_path", summary: {} },
      ]);
    } finally {
      await client.close();
    }
  });
});

async function seedRevision(
  client: PGlite,
  input: {
    id: string;
    summary: Record<string, unknown>;
    path: string;
    content: string;
  },
): Promise<void> {
  await client.query("INSERT INTO source_revisions (id, summary) VALUES ($1, $2::jsonb)", [
    input.id,
    JSON.stringify(input.summary),
  ]);
  await client.query("INSERT INTO source_files (revision_id, path, content) VALUES ($1, $2, $3)", [
    input.id,
    input.path,
    input.content,
  ]);
}
