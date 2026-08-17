import type { Pool } from "pg";
import { describe, expect, test, vi } from "vitest";
import {
  bootstrapEvelandWorkflowWorld,
  ensureEvelandWorkflowTenant,
} from "./eveland-workflow-world-bootstrap.js";

function testPool(): Pool {
  return { query: vi.fn(), end: vi.fn(async () => {}) } as unknown as Pool;
}

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
    const pool = testPool();
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

  test("applies pending migrations to an existing shared database during startup", async () => {
    const pool = testPool();
    const runMigrations = vi.fn(async () => ["0006_event_slots.sql"]);

    await expect(
      bootstrapEvelandWorkflowWorld(
        { EVELAND_WORKFLOW_WORLD_URL: "postgres://host/world" },
        { createPool: () => pool, runMigrations },
      ),
    ).resolves.toBe(true);

    expect(runMigrations).toHaveBeenCalledWith(pool);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  test("applies pending migrations before tenant provisioning", async () => {
    const pool = testPool();
    const runMigrations = vi.fn(async () => ["0006_event_slots.sql"]);
    const ensureTenantPartitions = vi.fn(async () => {});

    await expect(
      ensureEvelandWorkflowTenant("postgres://host/world", "proj_1", {
        createPool: () => pool,
        runMigrations,
        ensureTenantPartitions,
      }),
    ).resolves.toBeUndefined();

    expect(runMigrations).toHaveBeenCalledWith(pool);
    expect(ensureTenantPartitions).toHaveBeenCalledWith(pool, "proj_1");
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
