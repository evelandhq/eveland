import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test, vi } from "vitest";
import { createPgliteTestStore } from "./test-store.js";
import { createTestStore } from "./vitest-store.js";

describe("PGlite Store", () => {
  test("runs the production SQL Store against migrated PGlite", async () => {
    const database = await createPgliteTestStore();

    try {
      const project = await database.store.createProject({
        name: "pglite-store-contract",
        importKind: "zip",
      });

      await expect(database.store.getProject(project.id)).resolves.toMatchObject({
        id: project.id,
        slug: "pglite-store-contract",
      });
    } finally {
      await database.close();
    }
  });

  test("provides a synchronous Store facade for Vitest callers", async () => {
    const store = createTestStore();

    const project = await store.createProject({
      name: "pglite-vitest-contract",
      importKind: "zip",
    });

    await expect(store.getProject(project.id)).resolves.toMatchObject({
      id: project.id,
      slug: "pglite-vitest-contract",
    });
  });

  test("clones one migrated template into isolated Vitest stores", async () => {
    const clone = vi.spyOn(PGlite.prototype, "clone");
    try {
      const first = createTestStore();
      const second = createTestStore();

      const project = await first.createProject({
        name: "template-clone-contract",
        importKind: "zip",
      });

      await expect(second.getProject(project.id)).resolves.toBeNull();
      expect(clone).toHaveBeenCalledTimes(2);
    } finally {
      clone.mockRestore();
    }
  });
});
