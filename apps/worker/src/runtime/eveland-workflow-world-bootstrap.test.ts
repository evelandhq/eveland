import type { Pool } from "pg";
import { describe, expect, test, vi } from "vitest";
import { bootstrapEvelandWorkflowWorld } from "./eveland-workflow-world-bootstrap.js";

describe("bootstrapEvelandWorkflowWorld", () => {
  test("does nothing when the shared workflow database is not configured", async () => {
    const createPool = vi.fn();
    const runMigrations = vi.fn();

    await expect(bootstrapEvelandWorkflowWorld({}, { createPool, runMigrations })).resolves.toBe(
      false,
    );
    expect(createPool).not.toHaveBeenCalled();
    expect(runMigrations).not.toHaveBeenCalled();
  });

  test("applies migrations through the worker-reachable URL and closes its pool", async () => {
    const pool = { end: vi.fn(async () => {}) } as unknown as Pool;
    const createPool = vi.fn(() => pool);
    const runMigrations = vi.fn(async () => ["0005_terminal_stream_retention.sql"]);

    await expect(
      bootstrapEvelandWorkflowWorld(
        {
          EVELAND_WORKFLOW_WORLD_URL: "postgres://runtime:secret@runtime-db/workflow",
          EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL: "postgres://host:secret@host-db/workflow",
        },
        { createPool, runMigrations },
      ),
    ).resolves.toBe(true);

    expect(createPool).toHaveBeenCalledWith("postgres://host:secret@host-db/workflow");
    expect(runMigrations).toHaveBeenCalledWith(pool);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
