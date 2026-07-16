import { describe, expect, test, vi } from "vitest";
import {
  bootstrapWorkflowWorld,
  deriveProjectWorkflowDatabaseName,
  deriveProjectWorkflowUrl,
  dropProjectWorkflowWorld,
  ensureProjectWorkflowWorld,
} from "./workflow-world-bootstrap.js";

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

describe("deriveProjectWorkflowDatabaseName", () => {
  test("produces a stable lowercase name that keeps case-variant project ids distinct", () => {
    const name = deriveProjectWorkflowDatabaseName("proj_XegFad6y3w");

    expect(name).toMatch(/^eveland_wf_proj_xegfad6y3w_[0-9a-f]{6}$/);
    expect(deriveProjectWorkflowDatabaseName("proj_XegFad6y3w")).toBe(name);
    expect(deriveProjectWorkflowDatabaseName("proj_xegfad6y3w")).not.toBe(name);
  });
});

describe("deriveProjectWorkflowUrl", () => {
  test("replaces only the database name, preserving credentials, host, and query", () => {
    const url = deriveProjectWorkflowUrl("postgres://world:secret@db:5432/eveland?sslmode=require", "proj_abc123");

    const parsed = new URL(url);
    expect(parsed.username).toBe("world");
    expect(parsed.password).toBe("secret");
    expect(parsed.host).toBe("db:5432");
    expect(parsed.search).toBe("?sslmode=require");
    expect(parsed.pathname).toBe(`/${deriveProjectWorkflowDatabaseName("proj_abc123")}`);
  });
});

describe("ensureProjectWorkflowWorld", () => {
  test("does nothing without a platform world URL", async () => {
    const ensureDatabase = vi.fn();
    const run = vi.fn();

    await expect(
      ensureProjectWorkflowWorld({}, "proj_abc123", { ensureDatabase, run, cache: new Set() }),
    ).resolves.toBeUndefined();
    expect(ensureDatabase).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  test("creates and bootstraps the project database over the worker-reachable URL, returning the deployment URL", async () => {
    const ensureDatabase = vi.fn(async () => {});
    const run = vi.fn(async () => ({ exitCode: 0, all: "schema ready" }));
    const databaseName = deriveProjectWorkflowDatabaseName("proj_abc123");

    await expect(
      ensureProjectWorkflowWorld(
        {
          WORKFLOW_POSTGRES_URL: "postgres://world:secret@host.docker.internal:5432/eveland",
          DATABASE_URL: "postgres://world:secret@postgres:5432/eveland",
        },
        "proj_abc123",
        { ensureDatabase, run, resolveBin: () => "/bootstrap.js", cache: new Set() },
      ),
    ).resolves.toBe(`postgres://world:secret@host.docker.internal:5432/${databaseName}`);

    expect(ensureDatabase).toHaveBeenCalledExactlyOnceWith(
      "postgres://world:secret@postgres:5432/eveland",
      databaseName,
    );
    expect(run).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      ["/bootstrap.js"],
      {
        all: true,
        reject: false,
        extendEnv: false,
        env: { WORKFLOW_POSTGRES_URL: `postgres://world:secret@postgres:5432/${databaseName}` },
      },
    );
  });

  test("memoizes per project so repeated activations skip database work", async () => {
    const ensureDatabase = vi.fn(async () => {});
    const run = vi.fn(async () => ({ exitCode: 0, all: "schema ready" }));
    const cache = new Set<string>();
    const env = { WORKFLOW_POSTGRES_URL: "postgres://world:secret@db:5432/eveland" };

    const first = await ensureProjectWorkflowWorld(env, "proj_abc123", {
      ensureDatabase,
      run,
      resolveBin: () => "/bootstrap.js",
      cache,
    });
    const second = await ensureProjectWorkflowWorld(env, "proj_abc123", {
      ensureDatabase,
      run,
      resolveBin: () => "/bootstrap.js",
      cache,
    });

    expect(second).toBe(first);
    expect(ensureDatabase).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("fails without leaking the project database URL when bootstrap keeps failing", async () => {
    const ensureDatabase = vi.fn(async () => {});
    const run = vi.fn(async () => ({ exitCode: 1, all: "could not connect to postgres://world:secret@db:5432" }));

    await expect(
      ensureProjectWorkflowWorld(
        { WORKFLOW_POSTGRES_URL: "postgres://world:secret@db:5432/eveland" },
        "proj_abc123",
        { ensureDatabase, run, wait: async () => {}, maxAttempts: 2, resolveBin: () => "/bootstrap.js", cache: new Set() },
      ),
    ).rejects.toThrow(/\[redacted\]/);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("dropProjectWorkflowWorld", () => {
  test("does nothing without a platform world URL", async () => {
    const dropDatabase = vi.fn();

    await expect(
      dropProjectWorkflowWorld({}, "proj_abc123", { dropDatabase, cache: new Set() }),
    ).resolves.toBeUndefined();
    expect(dropDatabase).not.toHaveBeenCalled();
  });

  test("drops the project database over the worker-reachable URL and forgets the ensure cache", async () => {
    const ensureDatabase = vi.fn(async () => {});
    const dropDatabase = vi.fn(async () => {});
    const run = vi.fn(async () => ({ exitCode: 0, all: "schema ready" }));
    const cache = new Set<string>();
    const env = {
      WORKFLOW_POSTGRES_URL: "postgres://world:secret@host.docker.internal:5432/eveland",
      DATABASE_URL: "postgres://world:secret@postgres:5432/eveland",
    };

    await ensureProjectWorkflowWorld(env, "proj_abc123", {
      ensureDatabase,
      run,
      resolveBin: () => "/bootstrap.js",
      cache,
    });
    await dropProjectWorkflowWorld(env, "proj_abc123", { dropDatabase, cache });

    expect(dropDatabase).toHaveBeenCalledExactlyOnceWith(
      "postgres://world:secret@postgres:5432/eveland",
      deriveProjectWorkflowDatabaseName("proj_abc123"),
    );

    // The cache entry is gone, so a re-created project with the same id gets
    // a fresh database instead of a stale cache hit.
    await ensureProjectWorkflowWorld(env, "proj_abc123", {
      ensureDatabase,
      run,
      resolveBin: () => "/bootstrap.js",
      cache,
    });
    expect(ensureDatabase).toHaveBeenCalledTimes(2);
  });
});
