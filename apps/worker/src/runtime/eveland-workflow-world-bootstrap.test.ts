import type { Pool } from "pg";
import { describe, expect, test, vi } from "vitest";
import {
  bootstrapEvelandWorkflowWorld,
  ensureEvelandWorkflowTenant,
} from "./eveland-workflow-world-bootstrap.js";

function poolWithMigrationRegistry(applied: boolean | null): Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("to_regclass")) {
      return { rows: [{ registry: applied === null ? null : "workflow.eveland_migrations" }] };
    }
    if (sql.includes("eveland_migrations")) {
      return { rows: applied ? [{ name: "0006_event_slots.sql" }] : [] };
    }
    return { rows: [] };
  });
  return { query, end: vi.fn(async () => {}) } as unknown as Pool;
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
    const pool = poolWithMigrationRegistry(null);
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

  test("blocks an unattended upgrade when the disruptive migration is pending", async () => {
    const pool = poolWithMigrationRegistry(false);
    const runMigrations = vi.fn();

    await expect(
      bootstrapEvelandWorkflowWorld(
        { EVELAND_WORKFLOW_WORLD_URL: "postgres://host/world" },
        { createPool: () => pool, runMigrations },
      ),
    ).rejects.toThrow(/maintenance window.*workflow-world-setup/is);

    expect(runMigrations).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  test("allows startup after the disruptive migration was applied explicitly", async () => {
    const pool = poolWithMigrationRegistry(true);
    const runMigrations = vi.fn(async () => []);

    await expect(
      bootstrapEvelandWorkflowWorld(
        { EVELAND_WORKFLOW_WORLD_URL: "postgres://host/world" },
        { createPool: () => pool, runMigrations },
      ),
    ).resolves.toBe(true);

    expect(runMigrations).toHaveBeenCalledWith(pool);
  });

  test("applies the same maintenance gate before tenant provisioning", async () => {
    const pool = poolWithMigrationRegistry(false);
    const runMigrations = vi.fn();
    const ensureTenantPartitions = vi.fn();

    await expect(
      ensureEvelandWorkflowTenant("postgres://host/world", "proj_1", {
        createPool: () => pool,
        runMigrations,
        ensureTenantPartitions,
      }),
    ).rejects.toThrow(/maintenance window.*workflow-world-setup/is);

    expect(runMigrations).not.toHaveBeenCalled();
    expect(ensureTenantPartitions).not.toHaveBeenCalled();
  });
});
