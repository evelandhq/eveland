import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("project logs surface", () => {
  test("renders an interactive, searchable project log viewer", () => {
    const logs = source("./projects/[projectId]/logs/page.tsx");
    const viewer = source("../components/project-log-viewer.tsx");

    expect(logs).toContain("ProjectLogViewer");
    expect(logs).not.toContain("searchParams");
    expect(viewer).toContain('"use client"');
    expect(viewer).toContain("Search logs");
    expect(viewer).toContain('aria-label="Filter project logs"');
    expect(viewer).toContain("selectProjectLogs");
    expect(viewer).toContain("ToggleGroup");
    expect(viewer).toContain("ScrollArea");
    expect(viewer).toContain("CollapsibleTrigger");
    expect(viewer).toContain("Newest first");
    expect(viewer).toContain("Show full log");
  });
});
