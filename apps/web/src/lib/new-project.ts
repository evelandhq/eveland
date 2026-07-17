import type { Job, Project } from "./api";

export type NewProjectProgress = {
  phase: "importing" | "deploying" | "ready" | "failed";
  detail: string;
};

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
