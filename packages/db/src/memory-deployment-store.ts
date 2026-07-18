import type { DeploymentRecord, ReleaseRecord } from "@eveland/core/contracts";
import { claimDeploymentKey, createId } from "@eveland/core/ids";
import { createEveVersionInfo, readDeclaredEveVersion } from "@eveland/core/source";
import type { MemoryState } from "./memory-state.js";
import type { MemoryDomain } from "./memory-store-support.js";
import type { DeploymentStore } from "./store-domains.js";

export function createMemoryDeploymentStore(
  state: MemoryState,
): MemoryDomain<Omit<DeploymentStore, "getDeploymentRetention">> {
  return {
    async recordDeployment(input) {
      const now = new Date().toISOString();
      const release: ReleaseRecord = {
        id: input.releaseId ?? createId("rel"),
        projectId: input.projectId,
        sourceRevisionId: input.sourceRevisionId,
        imageTag: input.imageTag,
        createdAt: now,
      };
      const deployment = await claimDeploymentKey(async (deploymentKey) => {
        if (
          state.deployments.some(
            (candidate) => candidate.projectId === input.projectId && candidate.deploymentKey === deploymentKey,
          )
        ) {
          return null;
        }
        const claimed: DeploymentRecord = {
          id: input.deploymentId ?? createId("dep"),
          deploymentKey,
          projectId: input.projectId,
          releaseId: release.id,
          containerName: input.containerName,
          internalPort: input.internalPort,
          hostPort: input.hostPort,
          status: "running",
          runtimeKind: input.runtimeKind,
          createdAt: now,
          updatedAt: now,
        };
        state.deployments.push(claimed);
        return claimed;
      });
      state.releases.push(release);

      const project = state.projects.find((candidate) => candidate.id === input.projectId);
      if (project && !project.deploymentId) {
        project.status = "deployed";
        project.deploymentStatus = "running";
        project.releaseId = release.id;
        project.deploymentId = deployment.id;
        project.updatedAt = now;
      }

      return deployment;
    },

    async getCurrentDeployment(projectId) {
      const project = state.projects.find((candidate) => candidate.id === projectId);
      return state.deployments.find((deployment) => deployment.id === project?.deploymentId) ?? null;
    },

    async listDeployments(projectId) {
      return state.deployments
        .filter((deployment) => deployment.projectId === projectId)
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || state.deployments.indexOf(right) - state.deployments.indexOf(left),
        );
    },

    async getDeployment(deploymentId) {
      return state.deployments.find((deployment) => deployment.id === deploymentId) ?? null;
    },

    async getDeploymentEveVersion(deploymentId) {
      const deployment = state.deployments.find((candidate) => candidate.id === deploymentId);
      const release = state.releases.find((candidate) => candidate.id === deployment?.releaseId);
      const revision = state.sourceRevisions.find((candidate) => candidate.id === release?.sourceRevisionId);
      if (!revision) return null;
      let version = typeof revision.summary.eveVersion === "string" ? revision.summary.eveVersion : null;
      if (!version) {
        const packageJson = state.sourceFiles.find(
          (file) => file.revisionId === revision.id && file.path === "package.json",
        );
        if (packageJson) version = readDeclaredEveVersion([{ path: packageJson.path, content: packageJson.content }]);
      }
      return createEveVersionInfo(version, revision.id);
    },

    async getDeploymentByContainerName(containerName) {
      // Container names embed the deployment id, so at most one row matches;
      // newest-first keeps the answer deterministic even if that ever changes.
      return [...state.deployments]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .find((deployment) => deployment.containerName === containerName) ?? null;
    },

    async updateDeploymentStatus(deploymentId, status) {
      const deployment = state.deployments.find((candidate) => candidate.id === deploymentId);
      if (!deployment) return null;
      deployment.status = status;
      deployment.updatedAt = new Date().toISOString();
      return deployment;
    },

    async getRelease(releaseId) {
      return state.releases.find((release) => release.id === releaseId) ?? null;
    },

  };
}
