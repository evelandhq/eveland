import { describe, expect, test, vi } from "vitest";
import { bootstrapWorkflowWorld } from "./workflow-world-bootstrap.js";

describe("bootstrapWorkflowWorld", () => {
  test("does nothing when the platform world URL is not configured", async () => {
    const run = vi.fn();

    await expect(bootstrapWorkflowWorld({}, { run })).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  test("fails fast when a production worker has no platform world URL", async () => {
    await expect(bootstrapWorkflowWorld({ NODE_ENV: "production" })).rejects.toThrow(
      "WORKFLOW_POSTGRES_URL is required",
    );
  });

  test("runs the pinned package bootstrap with only the workflow database URL in its environment", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, all: "schema ready" }));

    await expect(
      bootstrapWorkflowWorld(
        { WORKFLOW_POSTGRES_URL: "postgres://world:secret@db:5432/eveland" },
        { run, resolveBin: () => "/workspace/node_modules/@workflow/world-postgres/bin/setup.js" },
      ),
    ).resolves.toBe("schema ready");

    expect(run).toHaveBeenCalledWith(
      process.execPath,
      ["/workspace/node_modules/@workflow/world-postgres/bin/setup.js"],
      {
        all: true,
        reject: false,
        extendEnv: false,
        env: { WORKFLOW_POSTGRES_URL: "postgres://world:secret@db:5432/eveland" },
      },
    );
  });

  test("uses a worker-reachable bootstrap URL without changing the deployment URL", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, all: "schema ready" }));

    await bootstrapWorkflowWorld(
      {
        WORKFLOW_POSTGRES_URL: "postgres://world:secret@host.docker.internal:5432/eveland",
        WORKFLOW_POSTGRES_BOOTSTRAP_URL: "postgres://world:secret@postgres:5432/eveland",
      },
      { run, resolveBin: () => "/bootstrap.js" },
    );

    expect(run).toHaveBeenCalledWith(
      process.execPath,
      ["/bootstrap.js"],
      expect.objectContaining({
        env: { WORKFLOW_POSTGRES_URL: "postgres://world:secret@postgres:5432/eveland" },
      }),
    );
  });

  test("uses the reachable control-plane URL when it is the same database behind host.docker.internal", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, all: "schema ready" }));

    await bootstrapWorkflowWorld(
      {
        DATABASE_URL: "postgres://world:secret@localhost:5432/eveland",
        WORKFLOW_POSTGRES_URL: "postgres://world:secret@host.docker.internal:5432/eveland",
      },
      { run, resolveBin: () => "/bootstrap.js" },
    );

    expect(run).toHaveBeenCalledWith(
      process.execPath,
      ["/bootstrap.js"],
      expect.objectContaining({
        env: { WORKFLOW_POSTGRES_URL: "postgres://world:secret@localhost:5432/eveland" },
      }),
    );
  });

  test("treats an empty bootstrap override as unset instead of letting the package use its default database", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, all: "schema ready" }));

    await bootstrapWorkflowWorld(
      {
        WORKFLOW_POSTGRES_URL: "postgres://world:secret@host.docker.internal:5432/eveland",
        WORKFLOW_POSTGRES_BOOTSTRAP_URL: "",
      },
      { run, resolveBin: () => "/bootstrap.js" },
    );

    expect(run).toHaveBeenCalledWith(
      process.execPath,
      ["/bootstrap.js"],
      expect.objectContaining({
        env: { WORKFLOW_POSTGRES_URL: "postgres://world:secret@host.docker.internal:5432/eveland" },
      }),
    );
  });

  test("retries a database that is not ready and returns after the first successful bootstrap", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, all: "connection refused" })
      .mockResolvedValueOnce({ exitCode: 1, all: "connection refused" })
      .mockResolvedValueOnce({ exitCode: 0, all: "schema ready" });
    const wait = vi.fn(async () => {});

    await expect(
      bootstrapWorkflowWorld(
        { WORKFLOW_POSTGRES_URL: "postgres://world:secret@db:5432/eveland" },
        { run, wait, maxAttempts: 3, retryDelayMs: 25, resolveBin: () => "/bootstrap.js" },
      ),
    ).resolves.toBe("schema ready");

    expect(run).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 25);
  });

  test("fails without leaking the configured database URL after retries are exhausted", async () => {
    const workflowPostgresUrl = "postgres://world:secret@db:5432/eveland";
    const run = vi.fn(async () => ({ exitCode: 1, all: `could not connect to ${workflowPostgresUrl}` }));

    await expect(
      bootstrapWorkflowWorld(
        { WORKFLOW_POSTGRES_URL: workflowPostgresUrl },
        { run, wait: async () => {}, maxAttempts: 2, resolveBin: () => "/bootstrap.js" },
      ),
    ).rejects.toThrow("could not connect to [redacted]");

    try {
      await bootstrapWorkflowWorld(
        { WORKFLOW_POSTGRES_URL: workflowPostgresUrl },
        { run, wait: async () => {}, maxAttempts: 1, resolveBin: () => "/bootstrap.js" },
      );
    } catch (error) {
      expect(String(error)).not.toContain(workflowPostgresUrl);
      expect(String(error)).not.toContain("secret");
    }
  });
});
