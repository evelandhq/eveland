import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("project logs surface", () => {
  test("renders a centered log page with tabs, search, and compact rows", () => {
    const logs = source("./projects/[projectId]/logs/page.tsx");
    const viewer = source("../components/project-log-viewer.tsx");

    expect(logs).toContain("ProjectLogViewer");
    expect(logs).not.toContain("searchParams");
    expect(logs).toContain("max-w-4xl");
    expect(logs).toContain(">Logs</h2>");
    expect(viewer).toContain('"use client"');
    expect(viewer).toContain("Search logs");
    expect(viewer).toContain('aria-label="Filter project logs"');
    expect(viewer).toContain("selectProjectLogs");
    expect(viewer).toContain("TabsList");
    expect(viewer).toContain("TabsTrigger");
    expect(viewer).not.toContain('variant="line"');
    expect(viewer).not.toContain("ToggleGroup");
    expect(viewer).toContain("ScrollArea");
    expect(viewer).toContain("CollapsibleTrigger");
    expect(viewer).not.toContain("Newest first");
    expect(viewer).not.toContain("Oldest first");
    expect(viewer).toContain('order: "desc"');
    expect(viewer).toContain("truncate min-w-0 flex-1");
    expect(viewer).toContain("Show full log");
  });

  test("uses compact standard tabs", () => {
    const viewer = source("../components/project-log-viewer.tsx");

    expect(viewer).toContain('className="h-7!"');
    expect(viewer).toContain('className="text-xs"');
    expect(viewer).toContain("overflow-x-auto overflow-y-hidden");
    expect(viewer).not.toContain('variant="line"');
  });

  test("fills the available project content height", () => {
    const logs = source("./projects/[projectId]/logs/page.tsx");
    const viewer = source("../components/project-log-viewer.tsx");
    const projectContent = source("../components/project-content.tsx");

    expect(projectContent).toContain('pathname.endsWith("/logs")');
    expect(projectContent).toContain('"h-[calc(100svh-3rem)] md:h-svh"');
    expect(logs).toContain("min-h-0 flex-1");
    expect(viewer).toContain('className="flex min-h-0 flex-1 flex-col gap-3"');
    expect(viewer).toContain('<ScrollArea className="min-h-0 flex-1">');
    expect(viewer).not.toContain("h-[calc(100svh-");
  });
});
