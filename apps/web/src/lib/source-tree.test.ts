import { describe, expect, test } from "vitest";

type SourceTreeModule = {
  getNextSourcePath(
    selectedPaths: readonly string[],
    currentPath: string | null,
    availablePaths: ReadonlySet<string>,
  ): string | null;
};

async function loadSourceTreeModule(): Promise<SourceTreeModule | null> {
  const modulePath = "./source-tree";
  return import(modulePath).catch(() => null) as Promise<SourceTreeModule | null>;
}

describe("source tree selection", () => {
  test("chooses the newly selected file when Trees retains the current file", async () => {
    const sourceTree = await loadSourceTreeModule();

    expect(sourceTree).not.toBeNull();
    expect(
      sourceTree?.getNextSourcePath(
        ["AGENTS.md", "package.json"],
        "AGENTS.md",
        new Set(["AGENTS.md", "package.json"]),
      ),
    ).toBe("package.json");
  });

  test("ignores directory-only selection changes", async () => {
    const sourceTree = await loadSourceTreeModule();

    expect(sourceTree).not.toBeNull();
    expect(
      sourceTree?.getNextSourcePath(["agent"], "AGENTS.md", new Set(["AGENTS.md", "package.json"])),
    ).toBeNull();
  });
});
