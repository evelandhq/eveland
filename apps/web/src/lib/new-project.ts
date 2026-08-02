import { ENVIRONMENT_ENTRY_KEY_PATTERN } from "@eveland/core/environment-entries";
import type { Job, Project } from "./api";

export type NewProjectProgress = {
  phase: "importing" | "deploying" | "ready" | "failed";
  detail: string;
};

export type NewProjectEnvironmentVariableErrors = { key?: string; value?: string };

export type NewProjectEnvironmentVariable = {
  id: number;
  key: string;
  kind: "variable" | "secret";
  value: string;
  visible: boolean;
};

const environmentVariablePattern = ENVIRONMENT_ENTRY_KEY_PATTERN;

export function getNewProjectProgress(project: Project | null, jobs: Job[]): NewProjectProgress {
  const importJob = jobs.find((job) => job.type === "import_source") ?? null;
  const deployJob = jobs.find((job) => job.type === "build_deploy") ?? null;
  const failedJob = deployJob?.status === "failed" ? deployJob : importJob?.status === "failed" ? importJob : null;

  if (failedJob) {
    return {
      phase: "failed",
      detail: failedJob.lastError ?? "Deployment failed. Open the project for more details.",
    };
  }
  if (project?.deploymentStatus === "running" && project.deploymentId) {
    return { phase: "ready", detail: "Your agent is live." };
  }
  if (deployJob || project?.sourceRevisionId || project?.deploymentStatus === "building") {
    return {
      phase: "deploying",
      detail: deployJob?.status === "running" ? "Building and starting your agent…" : "Preparing the first deployment…",
    };
  }
  return {
    phase: "importing",
    detail: importJob?.status === "running" ? "Fetching and validating the source…" : "Waiting for a worker to import the source…",
  };
}

export function validateNewProjectEnvironmentVariables<T extends { id: number; key: string; value: string }>(
  drafts: T[],
): { variables: T[]; errors: Map<number, NewProjectEnvironmentVariableErrors>; invalid: boolean } {
  const variables = drafts.filter((variable) => variable.key.trim().length > 0 || variable.value.length > 0);
  const keyCounts = new Map<string, number>();
  for (const variable of variables) {
    const key = variable.key.trim();
    if (key) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  const errors = new Map<number, NewProjectEnvironmentVariableErrors>();
  for (const variable of variables) {
    const key = variable.key.trim();
    const variableErrors: NewProjectEnvironmentVariableErrors = {};
    if (!key) {
      variableErrors.key = "Enter a variable name.";
    } else if (!environmentVariablePattern.test(key)) {
      variableErrors.key = "Use uppercase letters, numbers, and underscores, starting with a letter.";
    } else if ((keyCounts.get(key) ?? 0) > 1) {
      variableErrors.key = "Environment variable keys must be unique.";
    }
    if (!variable.value) variableErrors.value = "Enter a value or remove this variable.";
    if (variableErrors.key || variableErrors.value) errors.set(variable.id, variableErrors);
  }

  return { variables, errors, invalid: errors.size > 0 };
}

export function mergeImportedEnvironmentVariables(
  existing: NewProjectEnvironmentVariable[],
  imported: Array<Pick<NewProjectEnvironmentVariable, "key" | "kind" | "value">>,
  createId: () => number,
): NewProjectEnvironmentVariable[] {
  const importedByKey = new Map(imported.map((entry) => [entry.key, entry]));
  const merged = existing.map((entry) => {
    const replacement = importedByKey.get(entry.key);
    if (!replacement) return { ...entry, visible: false };
    importedByKey.delete(entry.key);
    return { ...entry, ...replacement, visible: false };
  });
  importedByKey.forEach((entry) => {
    merged.push({ id: createId(), ...entry, visible: false });
  });
  return merged;
}
