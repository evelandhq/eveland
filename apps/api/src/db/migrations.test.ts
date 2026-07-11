import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("project slug migration", () => {
  test("backfills deterministic DNS-safe slugs without truncating the unique suffix", async () => {
    const sql = await readFile(path.resolve("drizzle/0005_clever_rictor.sql"), "utf8");

    expect(sql).toContain("row_number() over (order by \"created_at\", \"id\")");
    expect(sql).toContain("greatest(12, length(count(*) over ()::text))");
    expect(sql).toContain("lpad(slug_number::text, suffix_width, '0')");
    expect(sql).toContain("trim(trailing '-' from left(base, greatest(1, 63 - 1 - suffix_width)))");
    expect(sql).toContain("coalesce(nullif(trim(both '-' from regexp_replace(lower(\"name\"), '[^a-z0-9]+', '-', 'g')), ''), 'agent')");
    expect(sql).not.toContain("substring(\"id\"");
  });
});
