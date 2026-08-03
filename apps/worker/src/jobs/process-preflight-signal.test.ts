import { createTestStore } from "@eveland/db/vitest";
import { describe, expect, test, vi } from "vitest";

const { importGitSource, getGitCommitSha, scanEveSource } = vi.hoisted(() => ({
  importGitSource: vi.fn<(input: { signal?: AbortSignal }) => Promise<void>>(async () => undefined),
  getGitCommitSha: vi.fn<(sourcePath: string, signal?: AbortSignal) => Promise<string>>(
    async () => "abc123",
  ),
  scanEveSource: vi.fn(async () => ({ summary: {} })),
}));
vi.mock("../source/importer.js", () => ({ importGitSource, getGitCommitSha }));
vi.mock("../source/scan.js", () => ({ scanEveSource }));

import { processNextSourcePreflight } from "./process-source-preflight.js";

describe("source preflight fencing", () => {
  test("threads the heartbeat abort signal through the git import", async () => {
    const store = createTestStore();
    await store.createSourcePreflight({
      userId: "user_local_admin",
      kind: "git",
      gitUrl: "https://github.com/example/agent.git",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(processNextSourcePreflight(store, "signal-worker")).resolves.toBe(true);

    // A lost lease aborts the controller; the host side effects (clone and
    // commit resolution) must be on that same fence.
    expect(importGitSource).toHaveBeenCalledTimes(1);
    expect(importGitSource.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
    expect(getGitCommitSha.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
  });
});
