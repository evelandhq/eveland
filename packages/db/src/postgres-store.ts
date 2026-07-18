import { and, eq } from "drizzle-orm";
import type { JobType } from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import type { Database } from "./client.js";
import { agentRouteRowToAgentRoute, jobRowToJob } from "./mappers.js";
import { createPostgresAgentAuthStore } from "./postgres-agent-auth-store.js";
import { createPostgresDeploymentRoutingStore } from "./postgres-deployment-routing-store.js";
import { createPostgresJobSourceStore } from "./postgres-job-source-store.js";
import { createPostgresProjectStore } from "./postgres-project-store.js";
import { createPostgresRuntimeStore } from "./postgres-runtime-store.js";
import { createPostgresScheduleStore } from "./postgres-schedule-store.js";
import { createPostgresSecretStore } from "./postgres-secret-store.js";
import { createPostgresSessionQueryStore } from "./postgres-session-query-store.js";
import { createPostgresSessionStore } from "./postgres-session-store.js";
import {
  agentRoutes,
  deployments,
  jobs,
  projects,
  routeTargets,
  teams,
  users,
} from "./schema.js";
import type { Store } from "./store-domains.js";
import {
  normalizeBaseDomain,
  type PostgresStoreContext,
} from "./postgres-store-support.js";
import { DEFAULT_TEAM_ID } from "./store-shared.js";

const defaultOwner = {
  id: "user_local_admin",
  email: "admin@example.com",
  name: "Local Admin",
};

export function createPostgresStore(database: Database): Store {
  const { db } = database;

  async function ensureDeploymentRoutes(
    projectId: string,
    deploymentId: string,
    baseDomain: string,
  ) {
    const domain = normalizeBaseDomain(baseDomain);
    return db.transaction(async (tx) => {
      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const [deployment] = await tx
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.id, deploymentId),
            eq(deployments.projectId, projectId),
          ),
        )
        .limit(1);
      if (!project || !deployment)
        throw new Error(
          "Cannot create Agent routes for an unknown project or deployment.",
        );

      let [stable] = await tx
        .select()
        .from(agentRoutes)
        .where(
          and(
            eq(agentRoutes.projectId, projectId),
            eq(agentRoutes.kind, "project"),
          ),
        )
        .limit(1);
      if (stable) {
        [stable] = await tx
          .update(agentRoutes)
          .set({
            hostname: `${project.slug}.${domain}`,
            enabled: true,
            updatedAt: new Date(),
          })
          .where(eq(agentRoutes.id, stable.id))
          .returning();
      } else {
        [stable] = await tx
          .insert(agentRoutes)
          .values({
            id: createId("route"),
            projectId,
            hostname: `${project.slug}.${domain}`,
            kind: "project",
            enabled: true,
            policyRevision: 1,
          })
          .returning();
      }
      if (!stable)
        throw new Error("Failed to materialize the stable Agent route.");

      const [previewMatch] = await tx
        .select({ route: agentRoutes })
        .from(agentRoutes)
        .innerJoin(routeTargets, eq(routeTargets.routeId, agentRoutes.id))
        .where(
          and(
            eq(agentRoutes.projectId, projectId),
            eq(agentRoutes.kind, "deployment"),
            eq(routeTargets.deploymentId, deploymentId),
          ),
        )
        .limit(1);
      let preview = previewMatch?.route;
      if (preview) {
        [preview] = await tx
          .update(agentRoutes)
          .set({
            hostname: `${deployment.deploymentKey}--${project.slug}.${domain}`,
            enabled: true,
            updatedAt: new Date(),
          })
          .where(eq(agentRoutes.id, preview.id))
          .returning();
      } else {
        [preview] = await tx
          .insert(agentRoutes)
          .values({
            id: createId("route"),
            projectId,
            hostname: `${deployment.deploymentKey}--${project.slug}.${domain}`,
            kind: "deployment",
            enabled: true,
            policyRevision: 1,
          })
          .returning();
      }
      if (!preview)
        throw new Error("Failed to materialize the deployment preview route.");

      const [existingStableTarget] = await tx
        .select()
        .from(routeTargets)
        .where(eq(routeTargets.routeId, stable.id))
        .limit(1);
      if (!existingStableTarget) {
        await tx
          .insert(routeTargets)
          .values({
            routeId: stable.id,
            deploymentId,
            weight: 10_000,
            variantName: null,
          });
      }
      await tx
        .insert(routeTargets)
        .values({
          routeId: preview.id,
          deploymentId,
          weight: 10_000,
          variantName: null,
        })
        .onConflictDoUpdate({
          target: [routeTargets.routeId, routeTargets.deploymentId],
          set: { weight: 10_000, variantName: null },
        });
      return [
        agentRouteRowToAgentRoute(stable),
        agentRouteRowToAgentRoute(preview),
      ];
    });
  }

  async function ensureDefaultOwner() {
    await db.transaction(async (tx) => {
      await tx
        .insert(teams)
        .values({ id: DEFAULT_TEAM_ID, name: "Eveland", slug: "eveland" })
        .onConflictDoNothing({ target: teams.id });
      await tx
        .insert(users)
        .values(defaultOwner)
        .onConflictDoNothing({ target: users.id });
    });
  }

  async function createJob(
    projectId: string,
    type: JobType,
    payload: Record<string, unknown>,
  ) {
    const [row] = await db
      .insert(jobs)
      .values({
        id: createId("job"),
        projectId,
        type,
        status: "queued",
        payload,
      })
      .returning();

    if (!row) throw new Error("Failed to create job.");
    return jobRowToJob(row);
  }

  const context: PostgresStoreContext = {
    database,
    db,
    ensureDeploymentRoutes,
    ensureDefaultOwner,
    createJob,
  };

  return {
    ...createPostgresProjectStore(context),
    ...createPostgresAgentAuthStore(context),
    ...createPostgresSecretStore(context),
    ...createPostgresJobSourceStore(context),
    ...createPostgresDeploymentRoutingStore(context),
    ...createPostgresSessionStore(context),
    ...createPostgresScheduleStore(context),
    ...createPostgresRuntimeStore(context),
    ...createPostgresSessionQueryStore(context),
  } as Store;
}
