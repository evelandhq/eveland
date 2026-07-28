import type { AgentCatalogRecord } from "@eveland/core/catalog";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import {
  agentRoutes,
  deployments,
  projects,
  releases,
  routeTargets,
  sourceRevisions,
} from "./schema.js";
import type { CatalogStore } from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";

export function createPostgresCatalogStore({
  db,
}: PostgresStoreContext): CatalogStore {
  return {
    async listAgentCatalog() {
      const rows = await db
        .select({
          projectId: projects.id,
          name: projects.name,
          description: projects.description,
          hostname: agentRoutes.hostname,
          deploymentStatus: deployments.status,
          summary: sourceRevisions.summary,
        })
        .from(projects)
        .innerJoin(
          agentRoutes,
          and(
            eq(agentRoutes.projectId, projects.id),
            eq(agentRoutes.kind, "project"),
            eq(agentRoutes.enabled, true),
          ),
        )
        .innerJoin(
          routeTargets,
          and(
            eq(routeTargets.routeId, agentRoutes.id),
            gt(routeTargets.weight, 0),
          ),
        )
        .innerJoin(
          deployments,
          eq(deployments.id, routeTargets.deploymentId),
        )
        .innerJoin(releases, eq(releases.id, deployments.releaseId))
        .innerJoin(
          sourceRevisions,
          eq(sourceRevisions.id, releases.sourceRevisionId),
        )
        .where(isNull(projects.deletionStatus))
        .orderBy(asc(projects.name), asc(projects.id));

      const grouped = new Map<
        string,
        Omit<AgentCatalogRecord, "capabilities"> & { eligible: boolean }
      >();
      for (const row of rows) {
        const current = grouped.get(row.projectId) ?? {
          projectId: row.projectId,
          name: row.name,
          description: row.description,
          hostname: row.hostname,
          eligible: true,
        };
        current.eligible &&=
          isCatalogRoutableDeploymentStatus(row.deploymentStatus) &&
          hasEveChatCapability(row.summary);
        grouped.set(row.projectId, current);
      }

      return [...grouped.values()]
        .filter((entry) => entry.eligible)
        .map(({ eligible: _eligible, ...entry }) => ({
          ...entry,
          capabilities: { eveChat: true as const },
        }));
    },
  };
}

function isCatalogRoutableDeploymentStatus(status: string): boolean {
  return status === "running" || status === "stopped";
}

function hasEveChatCapability(summary: unknown): boolean {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return false;
  }
  const capabilities = (summary as Record<string, unknown>).capabilities;
  return (
    Boolean(capabilities) &&
    typeof capabilities === "object" &&
    !Array.isArray(capabilities) &&
    (capabilities as Record<string, unknown>).eveChat === true
  );
}
