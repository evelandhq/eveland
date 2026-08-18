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
    await expect(bootstrapWorkflowWorld({})).resolves.toBeUndefined();
  });

  test("a production worker no longer requires the legacy world URL", async () => {
    // External-only installs never configure WORKFLOW_POSTGRES_URL; the
    // shared-world requirement lives in assertWorkflowTopologyPreflight.
    await expect(bootstrapWorkflowWorld({ NODE_ENV: "production" })).resolves.toBeUndefined();
  });

  test("does not initialize a legacy schema in the base database", async () => {
    await expect(
      bootstrapWorkflowWorld({
        WORKFLOW_POSTGRES_URL: "postgres://world:secret@unreachable.invalid:5432/eveland",
      }),
    ).resolves.toBeUndefined();
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
    const url = deriveProjectWorkflowUrl(
      "postgres://world:secret@db:5432/eveland?sslmode=require",
      "proj_abc123",
    );

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
    expect(run).toHaveBeenCalledExactlyOnceWith(process.execPath, ["/bootstrap.js"], {
      all: true,
      reject: false,
      extendEnv: false,
      env: { WORKFLOW_POSTGRES_URL: `postgres://world:secret@postgres:5432/${databaseName}` },
    });
  });

  test("uses an explicit worker-reachable bootstrap URL for the derived project database", async () => {
    const ensureDatabase = vi.fn(async () => {});
    const run = vi.fn(async () => ({ exitCode: 0, all: "schema ready" }));
    const databaseName = deriveProjectWorkflowDatabaseName("proj_abc123");

    await ensureProjectWorkflowWorld(
      {
        WORKFLOW_POSTGRES_URL: "postgres://world:secret@host.docker.internal:5432/eveland",
        WORKFLOW_POSTGRES_BOOTSTRAP_URL: "postgres://world:secret@postgres:5432/eveland",
      },
      "proj_abc123",
      { ensureDatabase, run, resolveBin: () => "/bootstrap.js", cache: new Set() },
    );

    expect(ensureDatabase).toHaveBeenCalledExactlyOnceWith(
      "postgres://world:secret@postgres:5432/eveland",
      databaseName,
    );
    expect(run).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      ["/bootstrap.js"],
      expect.objectContaining({
        env: { WORKFLOW_POSTGRES_URL: `postgres://world:secret@postgres:5432/${databaseName}` },
      }),
    );
  });

  test("treats an empty bootstrap override as unset for project provisioning", async () => {
    const ensureDatabase = vi.fn(async () => {});
    const run = vi.fn(async () => ({ exitCode: 0, all: "schema ready" }));
    const baseUrl = "postgres://world:secret@host.docker.internal:5432/eveland";
    const databaseName = deriveProjectWorkflowDatabaseName("proj_abc123");

    await ensureProjectWorkflowWorld(
      {
        WORKFLOW_POSTGRES_URL: baseUrl,
        WORKFLOW_POSTGRES_BOOTSTRAP_URL: "",
      },
      "proj_abc123",
      { ensureDatabase, run, resolveBin: () => "/bootstrap.js", cache: new Set() },
    );

    expect(ensureDatabase).toHaveBeenCalledExactlyOnceWith(baseUrl, databaseName);
    expect(run).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      ["/bootstrap.js"],
      expect.objectContaining({
        env: {
          WORKFLOW_POSTGRES_URL: `postgres://world:secret@host.docker.internal:5432/${databaseName}`,
        },
      }),
    );
  });

  test("retries project database setup until Postgres is ready", async () => {
    const ensureDatabase = vi.fn(async () => {});
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, all: "connection refused" })
      .mockResolvedValueOnce({ exitCode: 1, all: "connection refused" })
      .mockResolvedValueOnce({ exitCode: 0, all: "schema ready" });
    const wait = vi.fn(async () => {});

    await expect(
      ensureProjectWorkflowWorld(
        { WORKFLOW_POSTGRES_URL: "postgres://world:secret@db:5432/eveland" },
        "proj_abc123",
        {
          ensureDatabase,
          run,
          wait,
          maxAttempts: 3,
          retryDelayMs: 25,
          resolveBin: () => "/bootstrap.js",
          cache: new Set(),
        },
      ),
    ).resolves.toContain("eveland_wf_proj_abc123");

    expect(run).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 25);
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
    const run = vi.fn(async () => ({
      exitCode: 1,
      all: "could not connect to postgres://world:secret@db:5432",
    }));

    await expect(
      ensureProjectWorkflowWorld(
        { WORKFLOW_POSTGRES_URL: "postgres://world:secret@db:5432/eveland" },
        "proj_abc123",
        {
          ensureDatabase,
          run,
          wait: async () => {},
          maxAttempts: 2,
          resolveBin: () => "/bootstrap.js",
          cache: new Set(),
        },
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
