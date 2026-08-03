import { describe, expect, test } from "vitest";
import { samplePgInstanceConnections } from "./pg-connections.js";

const usage = { usedConnections: 42, maxConnections: 100 };

describe("samplePgInstanceConnections", () => {
  test("reports one shared instance when control plane and workflow share host and port", async () => {
    const queried: string[] = [];
    const samples = await samplePgInstanceConnections(
      {
        DATABASE_URL: "postgres://eveland:secret@localhost:5432/eveland",
        WORKFLOW_POSTGRES_URL: "postgres://eveland:secret@localhost:5432/eveland",
      },
      {
        queryInstance: async (url) => {
          queried.push(url);
          return usage;
        },
      },
    );

    expect(samples).toEqual([{ role: "shared", agentPoolSize: 10, ...usage }]);
    expect(queried).toHaveLength(1);
  });

  test("treats a host.docker.internal workflow alias of DATABASE_URL as the same instance", async () => {
    const samples = await samplePgInstanceConnections(
      {
        DATABASE_URL: "postgres://eveland:secret@localhost:5432/eveland",
        WORKFLOW_POSTGRES_URL: "postgres://eveland:secret@host.docker.internal:5432/eveland",
      },
      { queryInstance: async () => usage },
    );

    expect(samples).toEqual([{ role: "shared", agentPoolSize: 10, ...usage }]);
  });

  test("reports a control/workflow pair for split instances with pool size on the workflow side", async () => {
    const samples = await samplePgInstanceConnections(
      {
        DATABASE_URL: "postgres://eveland:secret@localhost:5432/eveland",
        WORKFLOW_POSTGRES_URL: "postgres://wf:secret@db.internal:5433/eveland",
        WORKFLOW_POSTGRES_MAX_POOL_SIZE: "5",
      },
      { queryInstance: async () => usage },
    );

    expect(samples).toEqual([
      { role: "control", agentPoolSize: null, ...usage },
      { role: "workflow", agentPoolSize: 5, ...usage },
    ]);
  });

  test("prefers the bootstrap URL for reaching the workflow instance", async () => {
    const queried: string[] = [];
    await samplePgInstanceConnections(
      {
        DATABASE_URL: "postgres://eveland:secret@localhost:5432/eveland",
        WORKFLOW_POSTGRES_URL: "postgres://wf:secret@host.docker.internal:5432/workflows",
        WORKFLOW_POSTGRES_BOOTSTRAP_URL: "postgres://wf:secret@127.0.0.1:5433/workflows",
      },
      {
        queryInstance: async (url) => {
          queried.push(url);
          return usage;
        },
      },
    );

    expect(queried).toContain("postgres://wf:secret@127.0.0.1:5433/workflows");
  });

  test("keeps the surviving instance when one query fails", async () => {
    const errors: string[] = [];
    const samples = await samplePgInstanceConnections(
      {
        DATABASE_URL: "postgres://eveland:secret@localhost:5432/eveland",
        WORKFLOW_POSTGRES_URL: "postgres://wf:secret@db.internal:5433/eveland",
      },
      {
        queryInstance: async (url) => {
          if (url.includes("db.internal")) throw new Error("connect ETIMEDOUT");
          return usage;
        },
        onInstanceError: (role) => errors.push(role),
      },
    );

    expect(samples).toEqual([{ role: "control", agentPoolSize: null, ...usage }]);
    expect(errors).toEqual(["workflow"]);
  });

  test("returns null when no database is configured or every query fails", async () => {
    expect(await samplePgInstanceConnections({}, { queryInstance: async () => usage })).toBeNull();
    expect(
      await samplePgInstanceConnections(
        { DATABASE_URL: "postgres://eveland:secret@localhost:5432/eveland" },
        {
          queryInstance: async () => {
            throw new Error("down");
          },
        },
      ),
    ).toBeNull();
  });
});
