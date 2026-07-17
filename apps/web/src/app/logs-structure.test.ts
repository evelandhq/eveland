import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("project logs surface", () => {
  test("matches the deployment terminal while keeping mixed project logs easy to scan", () => {
    const logs = source("./projects/[projectId]/logs/page.tsx");

    expect(logs).toContain("Project log stream");
    expect(logs).toContain("bg-foreground text-background");
    expect(logs).toContain("TerminalIcon");
    expect(logs).toContain("LOG_FILTERS");
    expect(logs).toContain("searchParams");
    expect(logs).toContain("aria-label=\"Filter project logs\"");
    expect(logs).toContain("<time");
    expect(logs).toContain("toLocaleTimeString");
    expect(logs).toContain("whitespace-pre-wrap break-words");
    expect(logs).toContain("<Empty");
  });
});
