import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

async function readJson(relativePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const absolutePath = path.join(directory, entry.name);
      return entry.isDirectory()
        ? listTypeScriptFiles(absolutePath)
        : Promise.resolve(/\.tsx?$/.test(entry.name) ? [absolutePath] : []);
    }),
  );
  return files.flat();
}

describe("package boundaries", () => {
  test("core exposes explicit browser-safe and Node-only subpaths without a root barrel", async () => {
    const manifest = await readJson("packages/core/package.json");

    expect(manifest).not.toBeNull();
    expect(manifest?.name).toBe("@eveland/core");
    expect(manifest?.exports).toMatchObject({
      "./contracts": "./src/contracts.ts",
      "./discovery": "./src/discovery.ts",
      "./eve": "./src/eve.ts",
      "./ids": "./src/ids.ts",
      "./schedules": "./src/schedules.ts",
      "./source": "./src/source.ts",
      "./server/archive": "./src/server/archive.ts",
      "./server/secrets": "./src/server/secrets.ts",
    });
    expect(Object.hasOwn(manifest?.exports as object, ".")).toBe(false);
  });

  test("db owns the store, store factory, and schema entrypoints", async () => {
    const manifest = await readJson("packages/db/package.json");

    expect(manifest).not.toBeNull();
    expect(manifest?.name).toBe("@eveland/db");
    expect(manifest?.exports).toMatchObject({
      ".": "./src/store.ts",
      "./factory": "./src/store-factory.ts",
      "./schema": "./src/schema.ts",
    });
  });

  test("worker depends only on packages and contains no api imports", async () => {
    const forbiddenAppPackage = ["@eveland", "api"].join("/");
    const manifest = await readJson("apps/worker/package.json");
    const dependencies = manifest?.dependencies as Record<string, string>;
    const sourceFiles = await listTypeScriptFiles(path.join(repoRoot, "apps/worker/src"));
    const imports = (await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")))).join("\n");

    expect(dependencies).not.toHaveProperty(forbiddenAppPackage);
    expect(dependencies).toMatchObject({
      "@eveland/core": "workspace:*",
      "@eveland/db": "workspace:*",
    });
    expect(imports).not.toContain(forbiddenAppPackage);
  });
});
