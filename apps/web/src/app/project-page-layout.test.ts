import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("project content page layout", () => {
  test.each([
    ["./projects/[projectId]/page.tsx", "Overview"],
    ["./projects/[projectId]/sessions/page.tsx", "Sessions"],
    ["./projects/[projectId]/schedules/page.tsx", "Schedules"],
    ["./projects/[projectId]/deployments/page.tsx", "Deployments"],
  ])("gives %s a visible title and centered reading width", (relativePath, title) => {
    const page = source(relativePath);

    expect(page).toContain("max-w-4xl");
    expect(page).toContain(`>${title}</h2>`);
    expect(page).toContain("text-2xl font-semibold tracking-tight");
  });

  test("gives project Usage the same centered width and title scale", () => {
    const page = source("./projects/[projectId]/usage/page.tsx");
    const explorer = source("../components/usage/usage-explorer.tsx");

    expect(page).toContain("max-w-4xl");
    expect(explorer).toContain('scope.type === "project" ? "text-2xl"');
    expect(explorer).toMatch(/>\s*Usage\s*<\/Heading>/);
  });
});
