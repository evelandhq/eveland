import { describe, expect, test, vi } from "vitest";
import { sweepWorkflowStreamRetention } from "./workflow-world-reaper.js";

describe("sweepWorkflowStreamRetention", () => {
  test("does nothing when the platform world URL is not configured", async () => {
    const listWorkflowDatabases = vi.fn();

    await expect(sweepWorkflowStreamRetention({}, {}, { listWorkflowDatabases })).resolves.toBe(0);
    expect(listWorkflowDatabases).not.toHaveBeenCalled();
  });

  test("prunes every per-project database on the bootstrap URL and sums deleted rows", async () => {
    const listWorkflowDatabases = vi.fn(async () => ["eveland_wf_a_111111", "eveland_wf_b_222222"]);
    const pruneTerminalStreamChunks = vi.fn(async () => 5);

    await expect(
      sweepWorkflowStreamRetention(
        { WORKFLOW_POSTGRES_URL: "postgres://world:secret@db:5432/eveland" },
        { retentionMs: 3_600_000, batchSize: 100 },
        { listWorkflowDatabases, pruneTerminalStreamChunks },
      ),
    ).resolves.toBe(10);

    expect(listWorkflowDatabases).toHaveBeenCalledWith(
      "postgres://world:secret@db:5432/eveland",
      "eveland_wf_",
    );
    expect(pruneTerminalStreamChunks).toHaveBeenCalledWith(
      "postgres://world:secret@db:5432/eveland_wf_a_111111",
      { retentionMs: 3_600_000, batchSize: 100 },
    );
    expect(pruneTerminalStreamChunks).toHaveBeenCalledWith(
      "postgres://world:secret@db:5432/eveland_wf_b_222222",
      { retentionMs: 3_600_000, batchSize: 100 },
    );
  });

  test("connects through the worker-reachable bootstrap URL when one is configured", async () => {
    const listWorkflowDatabases = vi.fn(async () => ["eveland_wf_a_111111"]);
    const pruneTerminalStreamChunks = vi.fn(async () => 0);

    await sweepWorkflowStreamRetention(
      {
        WORKFLOW_POSTGRES_URL: "postgres://world:secret@host.docker.internal:5432/eveland",
        WORKFLOW_POSTGRES_BOOTSTRAP_URL: "postgres://world:secret@postgres:5432/eveland",
      },
      {},
      { listWorkflowDatabases, pruneTerminalStreamChunks },
    );

    expect(listWorkflowDatabases).toHaveBeenCalledWith(
      "postgres://world:secret@postgres:5432/eveland",
      "eveland_wf_",
    );
    expect(pruneTerminalStreamChunks).toHaveBeenCalledWith(
      "postgres://world:secret@postgres:5432/eveland_wf_a_111111",
      expect.anything(),
    );
  });

  test("a database vanishing mid-sweep does not abort the remaining databases", async () => {
    const listWorkflowDatabases = vi.fn(async () => ["eveland_wf_gone_111111", "eveland_wf_kept_222222"]);
    const pruneTerminalStreamChunks = vi
      .fn()
      .mockRejectedValueOnce(new Error("database does not exist"))
      .mockResolvedValueOnce(7);
    const onDatabaseError = vi.fn();

    await expect(
      sweepWorkflowStreamRetention(
        { WORKFLOW_POSTGRES_URL: "postgres://world:secret@db:5432/eveland" },
        {},
        { listWorkflowDatabases, pruneTerminalStreamChunks, onDatabaseError },
      ),
    ).resolves.toBe(7);

    expect(pruneTerminalStreamChunks).toHaveBeenCalledTimes(2);
    expect(onDatabaseError).toHaveBeenCalledWith("eveland_wf_gone_111111", expect.any(Error));
  });

  test("falls back to safe defaults when options are not finite numbers", async () => {
    const listWorkflowDatabases = vi.fn(async () => ["eveland_wf_a_111111"]);
    const pruneTerminalStreamChunks = vi.fn(async () => 0);

    await sweepWorkflowStreamRetention(
      { WORKFLOW_POSTGRES_URL: "postgres://world:secret@db:5432/eveland" },
      { retentionMs: Number.NaN, batchSize: Number.NaN },
      { listWorkflowDatabases, pruneTerminalStreamChunks },
    );

    expect(pruneTerminalStreamChunks).toHaveBeenCalledWith(expect.any(String), {
      retentionMs: 86_400_000,
      batchSize: 50_000,
    });
  });
});
