import { describe, expect, test } from "vitest";
import type { Job, Project } from "./api";

type NewProjectModule = {
  getNewProjectProgress: (project: Project | null, jobs: Job[]) => {
    phase: "importing" | "deploying" | "ready" | "failed";
    detail: string;
  };
  validateNewProjectEnvironmentVariables: (variables: Array<{ id: number; key: string; value: string }>) => {
    variables: Array<{ id: number; key: string; value: string }>;
    errors: Map<number, { key?: string; value?: string }>;
    invalid: boolean;
  };
};

async function loadModule(): Promise<NewProjectModule | null> {
  return import("./new-project.js").catch(() => null) as Promise<NewProjectModule | null>;
}

const baseProject: Project = {
  id: "proj_123",
  slug: "support-agent",
  name: "support-agent",
  description: null,
  importKind: "git",
  gitUrl: "https://github.com/evelandhq/support-agent.git",
  status: "import_pending",
  deploymentStatus: "not_deployed",
  deletionStatus: null,
  deletionError: null,
  sourceRevisionId: null,
  releaseId: null,
  deploymentId: null,
  latestSessionStatus: null,
  nextScheduleAt: null,
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
};

function job(type: Job["type"], status: Job["status"], lastError: string | null = null): Job {
  return {
    id: `job_${type}`,
    projectId: baseProject.id,
    type,
    status,
    payload: {},
    attempts: status === "queued" ? 0 : 1,
    lastError,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:01.000Z",
  };
}

describe("new project deployment progress", () => {
  test("distinguishes importing, deploying, ready, and failed outcomes", async () => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) return;

    expect(module.getNewProjectProgress(baseProject, [job("import_source", "running")])).toMatchObject({
      phase: "importing",
    });
    expect(module.getNewProjectProgress(
      { ...baseProject, sourceRevisionId: "rev_123", status: "build_pending", deploymentStatus: "building" },
      [job("build_deploy", "running"), job("import_source", "completed")],
    )).toMatchObject({ phase: "deploying" });
    expect(module.getNewProjectProgress(
      { ...baseProject, sourceRevisionId: "rev_123", deploymentId: "dep_123", status: "deployed", deploymentStatus: "running" },
      [job("build_deploy", "completed"), job("import_source", "completed")],
    )).toMatchObject({ phase: "ready" });
    expect(module.getNewProjectProgress(baseProject, [job("import_source", "failed", "Unsupported Eve version")])).toEqual({
      phase: "failed",
      detail: "Unsupported Eve version",
    });
  });

  test("ignores empty optional rows and validates partial, malformed, and duplicate variables", async () => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const result = module.validateNewProjectEnvironmentVariables([
      { id: 1, key: "", value: "" },
      { id: 2, key: "OPENAI_API_KEY", value: "sk-first" },
      { id: 3, key: "OPENAI_API_KEY", value: "sk-second" },
      { id: 4, key: "lowercase", value: "value" },
      { id: 5, key: "MODEL_NAME", value: "" },
      { id: 6, key: "", value: "orphan-value" },
    ]);

    expect(result.variables.map((variable) => variable.id)).toEqual([2, 3, 4, 5, 6]);
    expect(result.invalid).toBe(true);
    expect(result.errors.get(1)).toBeUndefined();
    expect(result.errors.get(2)?.key).toBe("Environment variable keys must be unique.");
    expect(result.errors.get(3)?.key).toBe("Environment variable keys must be unique.");
    expect(result.errors.get(4)?.key).toContain("uppercase");
    expect(result.errors.get(5)?.value).toBe("Enter a value or remove this variable.");
    expect(result.errors.get(6)?.key).toBe("Enter a variable name.");
  });
});
