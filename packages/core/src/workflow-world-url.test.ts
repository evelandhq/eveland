import { describe, expect, test } from "vitest";
import {
  databaseName,
  deriveWorkflowWorldUrl,
  resolveWorkflowWorldDeploymentUrl,
  resolveWorkflowWorldPlatformUrl,
} from "./workflow-world-url.js";

describe("deriveWorkflowWorldUrl", () => {
  test("keeps the server and credentials, changes only the database", () => {
    expect(deriveWorkflowWorldUrl("postgres://eveland:eveland@127.0.0.1:17310/eveland")).toBe(
      "postgres://eveland:eveland@127.0.0.1:17310/eveland_workflow",
    );
    expect(deriveWorkflowWorldUrl("postgres://ops:pw@db.internal:6543/platform")).toBe(
      "postgres://ops:pw@db.internal:6543/platform_workflow",
    );
  });

  test("carries connection parameters through — a managed server's sslmode is not optional", () => {
    expect(
      deriveWorkflowWorldUrl("postgres://ops:pw@db.internal:6543/eveland?sslmode=require"),
    ).toBe("postgres://ops:pw@db.internal:6543/eveland_workflow?sslmode=require");
  });

  test("a DSN naming no database is an error, not a URL with an empty path", () => {
    expect(() => deriveWorkflowWorldUrl("postgres://eveland:eveland@127.0.0.1:17310")).toThrow(
      /names no database/,
    );
  });
});

describe("databaseName", () => {
  test("is the database alone: the same database seen from two networks has one name", () => {
    expect(databaseName("postgres://eveland:eveland@host.docker.internal:17310/eveland_workflow")) //
      .toBe(databaseName("postgres://eveland:eveland@127.0.0.1:17310/eveland_workflow"));
  });

  test("null when there is no database, and when the value is not a URL at all", () => {
    expect(databaseName("postgres://eveland:eveland@127.0.0.1:17310")).toBeNull();
    expect(databaseName("not a url")).toBeNull();
  });
});

describe("the two views of the shared world", () => {
  test("deployments get the container-reachable URL; the platform prefers the bootstrap one", () => {
    const env = {
      EVELAND_WORKFLOW_WORLD_URL: "postgres://e:e@host.docker.internal:17310/eveland_workflow",
      EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL: "postgres://e:e@127.0.0.1:17310/eveland_workflow",
    };
    expect(resolveWorkflowWorldDeploymentUrl(env)).toContain("host.docker.internal");
    expect(resolveWorkflowWorldPlatformUrl(env)).toContain("127.0.0.1");
  });
});
