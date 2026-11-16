import type { AgentCatalogRecord } from "@evelandhq/core/catalog";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { agentRoutes, deployments, projects, releases, routeTargets } from "./schema.js";
import type { CatalogStore } from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";

export function createPostgresCatalogStore({ db }: PostgresStoreContext): CatalogStore {
  return {
    async listAgentCatalog() {
      const rows = await db
        .select({
          projectId: projects.id,
          name: projects.name,
          description: projects.description,
          hostname: agentRoutes.hostname,
          deploymentStatus: deployments.status,
          releaseSummary: releases.summary,
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
          and(eq(routeTargets.routeId, agentRoutes.id), gt(routeTargets.weight, 0)),
        )
        .innerJoin(deployments, eq(deployments.id, routeTargets.deploymentId))
        .innerJoin(releases, eq(releases.id, deployments.releaseId))
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
          servesEveChannel(row.releaseSummary);
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

/**
 * Whether the built Release serves eve's chat channel, as `eve info --json`
 * reported it after the build: eve supplies that channel by default, so an
 * agent qualifies whether or not it authors `agent/channels/eve.ts`. A
 * Release recorded without a build summary does not qualify.
 */
function servesEveChannel(summary: unknown): boolean {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
  const channels = (summary as Record<string, unknown>).channels;
  return Array.isArray(channels) && channels.includes("eve");
}
