import { describe, expect, test } from "vitest";
import { ProjectSlugConflictError } from "./store.js";
import { createTestStore } from "./vitest-store.js";

describe("source preflight store", () => {
  test("keeps preflights user-scoped and fences worker completion by attempt", async () => {
    const store = createTestStore();
    const preflight = await store.createSourcePreflight({
      userId: "user_a",
      kind: "git",
      gitUrl: "https://github.com/evelandhq/example.git",
      expiresAt: new Date("2030-01-02T00:00:00.000Z"),
    });

    await expect(store.getSourcePreflight(preflight.id, "user_b")).resolves.toBeNull();
    await expect(store.getSourcePreflight(preflight.id, "user_a")).resolves.toMatchObject({
      id: preflight.id,
      status: "queued",
      kind: "git",
      gitUrl: "https://github.com/evelandhq/example.git",
    });

    const claimed = await store.claimNextSourcePreflight("worker-a");
    expect(claimed).toMatchObject({ id: preflight.id, status: "running", attempts: 1 });
    await expect(
      store.completeSourcePreflight(preflight.id, 0, {
        sourcePath: "/data/preflights/pre_1/source",
        commitSha: "abc123",
        summary: { eveVersion: "0.31.5", layout: "single-agent" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.completeSourcePreflight(preflight.id, claimed!.attempts, {
        sourcePath: "/data/preflights/pre_1/source",
        commitSha: "abc123",
        summary: { eveVersion: "0.31.5", layout: "single-agent" },
      }),
    ).resolves.toBe(true);

    await expect(store.getSourcePreflight(preflight.id, "user_a")).resolves.toMatchObject({
      status: "completed",
      summary: { eveVersion: "0.31.5", layout: "single-agent" },
    });
  });

  test("atomically creates a project from the validated snapshot and consumes it once", async () => {
    const store = createTestStore();
    const preflight = await store.createSourcePreflight({
      userId: "user_a",
      kind: "zip",
      sourcePath: "/data/uploads/zip-1/source",
      expiresAt: new Date("2030-01-02T00:00:00.000Z"),
    });
    const claimed = await store.claimNextSourcePreflight("worker-a");
    await store.completeSourcePreflight(preflight.id, claimed!.attempts, {
      sourcePath: "/data/uploads/zip-1/source",
      commitSha: null,
      summary: { eveVersion: "0.31.5" },
    });

    const result = await store.createProjectFromSourcePreflight({
      preflightId: preflight.id,
      userId: "user_a",
      name: "validated-agent",
      deployAfterImport: true,
      secrets: [
        { key: "OPENAI_API_KEY", kind: "secret", encryptedValue: "encrypted-openai-key" },
        { key: "MODEL_NAME", kind: "variable", encryptedValue: "encrypted-model-name" },
      ],
    });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("Expected project creation.");

    const jobs = await store.listProjectJobs(result.project.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: "import_source",
      payload: {
        importKind: "zip",
        sourcePath: "/data/uploads/zip-1/source",
        deployAfterImport: true,
      },
    });
    await expect(store.listSecretRecords(result.project.id)).resolves.toEqual([
      expect.objectContaining({
        key: "OPENAI_API_KEY",
        kind: "secret",
        encryptedValue: "encrypted-openai-key",
      }),
      expect.objectContaining({
        key: "MODEL_NAME",
        kind: "variable",
        encryptedValue: "encrypted-model-name",
      }),
    ]);
    await expect(
      store.createProjectFromSourcePreflight({
        preflightId: preflight.id,
        userId: "user_a",
        name: "second-agent",
        deployAfterImport: true,
      }),
    ).resolves.toEqual({ outcome: "consumed" });
  });

  test("does not consume a validated snapshot when its exact project name conflicts", async () => {
    const store = createTestStore();
    await store.createProject({ name: "taken-name", importKind: "zip", requireExactSlug: true });
    const preflight = await store.createSourcePreflight({
      userId: "user_a",
      kind: "zip",
      sourcePath: "/data/uploads/zip-2/source",
      expiresAt: new Date("2030-01-02T00:00:00.000Z"),
    });
    const claimed = await store.claimNextSourcePreflight("worker-a");
    await store.completeSourcePreflight(preflight.id, claimed!.attempts, {
      sourcePath: "/data/uploads/zip-2/source",
      commitSha: null,
      summary: {},
    });

    await expect(
      store.createProjectFromSourcePreflight({
        preflightId: preflight.id,
        userId: "user_a",
        name: "taken-name",
        deployAfterImport: true,
      }),
    ).rejects.toBeInstanceOf(ProjectSlugConflictError);
    await expect(store.getSourcePreflight(preflight.id, "user_a")).resolves.toMatchObject({
      status: "completed",
    });
  });

  test("expires only unconsumed terminal snapshots and returns their cleanup paths", async () => {
    const store = createTestStore();
    const preflight = await store.createSourcePreflight({
      userId: "user_a",
      kind: "zip",
      sourcePath: "/data/uploads/expired/source",
      expiresAt: new Date("2029-01-01T00:00:00.000Z"),
    });
    const claimed = await store.claimNextSourcePreflight("worker-a");
    await store.completeSourcePreflight(preflight.id, claimed!.attempts, {
      sourcePath: "/data/uploads/expired/source",
      commitSha: null,
      summary: {},
    });

    await expect(
      store.expireSourcePreflights(new Date("2030-01-01T00:00:00.000Z"), 25),
    ).resolves.toEqual(["/data/uploads/expired/source"]);
    await expect(store.getSourcePreflight(preflight.id, "user_a")).resolves.toBeNull();
  });
});
