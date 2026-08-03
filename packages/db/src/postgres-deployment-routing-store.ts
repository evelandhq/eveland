import type { DeploymentStatus } from "@eveland/core/contracts";
import { claimDeploymentKey, createId } from "@eveland/core/ids";
import { isSessionBindingActive, validateRouteTargets } from "@eveland/core/routing";
import { createEveVersionInfo, readDeclaredEveVersion } from "@eveland/core/source";
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import {
  agentRouteRowToAgentRoute,
  deploymentRowToDeployment,
  releaseRowToRelease,
  sessionBindingRowToSessionBinding,
} from "./mappers.js";
import {
  agentRoutes,
  activationLeases,
  deployments,
  runtimeInstances,
  projects,
  releases,
  routeTargets,
  sessionBindings,
  sessions,
  sourceFiles,
  sourceRevisions,
} from "./schema.js";
import {
  DeploymentNotFoundError,
  DeploymentNotPromotableError,
  ProjectRouteNotFoundError,
} from "./store-shared.js";
import type { DeploymentStore, RoutingStore } from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";
import {
  applySchedulerTargetTx,
  isUniqueConstraint,
  normalizeBaseDomain,
} from "./postgres-store-support.js";

type PostgresDeploymentRoutingDomain = DeploymentStore & RoutingStore;

export function createPostgresDeploymentRoutingStore({
  db,
}: PostgresStoreContext): PostgresDeploymentRoutingDomain {
  const ensureDeploymentRoutes: RoutingStore["ensureDeploymentRoutes"] = async (
    projectId,
    deploymentId,
    baseDomain,
  ) => {
    const domain = normalizeBaseDomain(baseDomain);
    return db.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      const [deployment] = await tx
        .select()
        .from(deployments)
        .where(and(eq(deployments.id, deploymentId), eq(deployments.projectId, projectId)))
        .limit(1);
      if (!project || !deployment) {
        throw new Error("Cannot create Agent routes for an unknown project or deployment.");
      }

      let [stable] = await tx
        .select()
        .from(agentRoutes)
        .where(and(eq(agentRoutes.projectId, projectId), eq(agentRoutes.kind, "project")))
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
      if (!stable) {
        throw new Error("Failed to materialize the stable Agent route.");
      }

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
      if (!preview) {
        throw new Error("Failed to materialize the deployment preview route.");
      }

      const [existingStableTarget] = await tx
        .select()
        .from(routeTargets)
        .where(eq(routeTargets.routeId, stable.id))
        .limit(1);
      if (!existingStableTarget) {
        await tx.insert(routeTargets).values({
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
      return [agentRouteRowToAgentRoute(stable), agentRouteRowToAgentRoute(preview)];
    });
  };

  const domain: PostgresDeploymentRoutingDomain = {
    async recordDeployment(input) {
      // One transaction: a release the database cannot address through a
      // deployment must never survive a failure between these writes.
      return db.transaction(async (tx) => {
        const [releaseRow] = await tx
          .insert(releases)
          .values({
            id: input.releaseId ?? createId("rel"),
            projectId: input.projectId,
            sourceRevisionId: input.sourceRevisionId,
            imageTag: input.imageTag,
            observerContract: input.observerContract ?? null,
            summary: input.summary ?? null,
          })
          .returning();

        if (!releaseRow) {
          throw new Error("Failed to create release.");
        }

        const deploymentRow = await claimDeploymentKey(async (deploymentKey) => {
          try {
            // Savepoint per attempt: a unique-constraint rejection would
            // otherwise poison the enclosing transaction and doom the retry.
            return await tx.transaction(async (attempt) => {
              const [claimed] = await attempt
                .insert(deployments)
                .values({
                  id: input.deploymentId ?? createId("dep"),
                  deploymentKey,
                  projectId: input.projectId,
                  releaseId: releaseRow.id,
                  containerName: input.containerName,
                  internalPort: input.internalPort,
                  hostPort: input.hostPort,
                  status: "running",
                  runtimeKind: input.runtimeKind,
                })
                .returning();
              if (!claimed) throw new Error("Failed to create deployment.");
              return claimed;
            });
          } catch (error) {
            if (isUniqueConstraint(error, "deployments_project_key_idx")) return null;
            throw error;
          }
        });

        await tx
          .update(projects)
          .set({
            status: "deployed",
            deploymentStatus: "running",
            releaseId: releaseRow.id,
            deploymentId: deploymentRow.id,
            updatedAt: new Date(),
          })
          .where(and(eq(projects.id, input.projectId), isNull(projects.deploymentId)));

        return deploymentRowToDeployment(deploymentRow);
      });
    },

    async getCurrentDeployment(projectId) {
      const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      if (!project?.deploymentId) {
        return null;
      }

      const [deployment] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, project.deploymentId))
        .limit(1);
      return deployment ? deploymentRowToDeployment(deployment) : null;
    },

    async listDeployments(projectId) {
      const rows = await db
        .select()
        .from(deployments)
        .where(eq(deployments.projectId, projectId))
        .orderBy(desc(deployments.createdAt), desc(deployments.id));
      return rows.map(deploymentRowToDeployment);
    },

    async listReservedDeploymentHostPorts() {
      const rows = await db
        .selectDistinct({ hostPort: deployments.hostPort })
        .from(deployments)
        .where(ne(deployments.status, "archived"));
      // Live RuntimeInstances can run on reallocated ports that no
      // deployments.host_port mentions; they are just as occupied.
      const instanceRows = await db
        .selectDistinct({ port: runtimeInstances.endpointPort })
        .from(runtimeInstances)
        .where(
          and(
            inArray(runtimeInstances.status, ["starting", "ready", "draining"]),
            isNotNull(runtimeInstances.endpointPort),
          ),
        );
      return [
        ...new Set([
          ...rows.map((row) => row.hostPort),
          ...instanceRows.map((row) => row.port as number),
        ]),
      ];
    },

    async getDeployment(deploymentId) {
      const [deployment] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, deploymentId))
        .limit(1);
      return deployment ? deploymentRowToDeployment(deployment) : null;
    },

    async getDeploymentEveVersion(deploymentId) {
      const [record] = await db
        .select({
          sourceRevisionId: sourceRevisions.id,
          summary: sourceRevisions.summary,
          releaseSummary: releases.summary,
        })
        .from(deployments)
        .innerJoin(releases, eq(releases.id, deployments.releaseId))
        .innerJoin(sourceRevisions, eq(sourceRevisions.id, releases.sourceRevisionId))
        .where(eq(deployments.id, deploymentId))
        .limit(1);
      if (!record) return null;
      const summary =
        record.summary && typeof record.summary === "object"
          ? (record.summary as Record<string, unknown>)
          : {};
      const releaseSummary =
        record.releaseSummary && typeof record.releaseSummary === "object"
          ? (record.releaseSummary as Record<string, unknown>)
          : {};
      // The build recorded the eve version actually installed into this
      // release; it outranks the revision's declared specifier.
      let version =
        typeof releaseSummary.eveVersionResolved === "string"
          ? releaseSummary.eveVersionResolved
          : typeof summary.eveVersion === "string"
            ? summary.eveVersion
            : null;
      if (!version) {
        const [packageJson] = await db
          .select({ path: sourceFiles.path, content: sourceFiles.content })
          .from(sourceFiles)
          .where(
            and(
              eq(sourceFiles.revisionId, record.sourceRevisionId),
              eq(sourceFiles.path, "package.json"),
            ),
          )
          .limit(1);
        if (packageJson) version = readDeclaredEveVersion([packageJson]);
      }
      return createEveVersionInfo(version, record.sourceRevisionId);
    },

    async getDeploymentByContainerName(containerName) {
      const [deployment] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.containerName, containerName))
        .orderBy(desc(deployments.createdAt), desc(deployments.id))
        .limit(1);
      return deployment ? deploymentRowToDeployment(deployment) : null;
    },

    async updateDeploymentStatus(deploymentId, status) {
      const [deployment] = await db
        .update(deployments)
        .set({ status, updatedAt: new Date() })
        .where(eq(deployments.id, deploymentId))
        .returning();
      return deployment ? deploymentRowToDeployment(deployment) : null;
    },

    async transitionDeploymentStatus({ deploymentId, to, from }) {
      if (from.length === 0) return null;
      const [deployment] = await db
        .update(deployments)
        .set({ status: to, updatedAt: new Date() })
        .where(and(eq(deployments.id, deploymentId), inArray(deployments.status, from)))
        .returning();
      return deployment ? deploymentRowToDeployment(deployment) : null;
    },

    async getRelease(releaseId) {
      const [release] = await db.select().from(releases).where(eq(releases.id, releaseId)).limit(1);
      return release ? releaseRowToRelease(release) : null;
    },

    async listReleaseSummaries(projectId) {
      // One project-scoped query: a deployment overview needs every listed
      // deployment's release summary, and per-release lookups would be an
      // unbounded N+1 over the full (archived included) deployment history.
      const rows = await db
        .select({ id: releases.id, summary: releases.summary })
        .from(releases)
        .where(eq(releases.projectId, projectId));
      return Object.fromEntries(
        rows.map((row) => [
          row.id,
          row.summary && typeof row.summary === "object" && !Array.isArray(row.summary)
            ? (row.summary as Record<string, unknown>)
            : null,
        ]),
      );
    },

    ensureDeploymentRoutes,

    async reconcileAgentRoutes(baseDomain) {
      const rows = await db
        .select({ projectId: projects.id, deploymentId: projects.deploymentId })
        .from(projects);
      for (const row of rows) {
        if (row.deploymentId)
          await ensureDeploymentRoutes(row.projectId, row.deploymentId, baseDomain);
      }
    },

    async findRouteByHostname(hostname) {
      const [route] = await db
        .select()
        .from(agentRoutes)
        .where(eq(agentRoutes.hostname, hostname.toLowerCase()))
        .limit(1);
      if (!route) return null;
      const targets = await db
        .select({
          routeId: routeTargets.routeId,
          deploymentId: routeTargets.deploymentId,
          weight: routeTargets.weight,
          variantName: routeTargets.variantName,
          hostPort: deployments.hostPort,
          status: deployments.status,
        })
        .from(routeTargets)
        .innerJoin(deployments, eq(deployments.id, routeTargets.deploymentId))
        .where(eq(routeTargets.routeId, route.id));
      return {
        ...agentRouteRowToAgentRoute(route),
        targets: targets.map((target) => ({
          ...target,
          status: target.status as DeploymentStatus,
        })),
      };
    },

    async findProjectRoute(projectId) {
      const [route] = await db
        .select()
        .from(agentRoutes)
        .where(and(eq(agentRoutes.projectId, projectId), eq(agentRoutes.kind, "project")))
        .limit(1);
      if (!route) return null;
      const targets = await db
        .select({
          routeId: routeTargets.routeId,
          deploymentId: routeTargets.deploymentId,
          weight: routeTargets.weight,
          variantName: routeTargets.variantName,
          hostPort: deployments.hostPort,
          status: deployments.status,
        })
        .from(routeTargets)
        .innerJoin(deployments, eq(deployments.id, routeTargets.deploymentId))
        .where(eq(routeTargets.routeId, route.id));
      return {
        ...agentRouteRowToAgentRoute(route),
        targets: targets.map((target) => ({
          ...target,
          status: target.status as DeploymentStatus,
        })),
      };
    },

    async listProjectRoutes(projectId) {
      const routeRows = await db
        .select()
        .from(agentRoutes)
        .where(eq(agentRoutes.projectId, projectId));
      const resolved = [];
      for (const route of routeRows) {
        const targets = await db
          .select({
            routeId: routeTargets.routeId,
            deploymentId: routeTargets.deploymentId,
            weight: routeTargets.weight,
            variantName: routeTargets.variantName,
            hostPort: deployments.hostPort,
            status: deployments.status,
          })
          .from(routeTargets)
          .innerJoin(deployments, eq(deployments.id, routeTargets.deploymentId))
          .where(eq(routeTargets.routeId, route.id));
        resolved.push({
          ...agentRouteRowToAgentRoute(route),
          targets: targets.map((target) => ({
            ...target,
            status: target.status as DeploymentStatus,
          })),
        });
      }
      return resolved;
    },

    async updateRouteTargets(routeId, targets) {
      validateRouteTargets(targets);
      await db.transaction(async (tx) => {
        const [route] = await tx
          .select()
          .from(agentRoutes)
          .where(eq(agentRoutes.id, routeId))
          .limit(1);
        if (!route) throw new Error("Agent route not found.");
        if (route.kind === "deployment")
          throw new Error("Deployment preview routes are immutable.");
        for (const target of targets) {
          const [deployment] = await tx
            .select()
            .from(deployments)
            .where(eq(deployments.id, target.deploymentId))
            .limit(1);
          if (!deployment || deployment.projectId !== route.projectId)
            throw new Error("Route target deployment does not belong to the project.");
          if (target.weight > 0 && deployment.status !== "running")
            throw new Error("A weighted route target must be running.");
        }
        await tx.delete(routeTargets).where(eq(routeTargets.routeId, routeId));
        await tx.insert(routeTargets).values(targets.map((target) => ({ routeId, ...target })));
        await tx
          .update(agentRoutes)
          .set({
            policyRevision: sql`${agentRoutes.policyRevision} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(agentRoutes.id, routeId));
      });
      const [route] = await db
        .select()
        .from(agentRoutes)
        .where(eq(agentRoutes.id, routeId))
        .limit(1);
      if (!route) throw new Error("Agent route not found after update.");
      return (await domain.findRouteByHostname(route.hostname))!;
    },

    async promoteDeployment(projectId, deploymentId) {
      const hostname = await db.transaction(async (tx) => {
        const [route] = await tx
          .select()
          .from(agentRoutes)
          .where(and(eq(agentRoutes.projectId, projectId), eq(agentRoutes.kind, "project")))
          .limit(1);
        const [deployment] = await tx
          .select()
          .from(deployments)
          .where(and(eq(deployments.id, deploymentId), eq(deployments.projectId, projectId)))
          .limit(1);
        if (!route) throw new ProjectRouteNotFoundError();
        if (!deployment) throw new DeploymentNotFoundError();
        if (deployment.status !== "running")
          throw new DeploymentNotPromotableError(
            `A promoted deployment must be running, but this one is ${deployment.status}.`,
          );
        await tx.delete(routeTargets).where(eq(routeTargets.routeId, route.id));
        await tx.insert(routeTargets).values({
          routeId: route.id,
          deploymentId,
          weight: 10_000,
          variantName: null,
        });
        await tx
          .update(agentRoutes)
          .set({
            policyRevision: sql`${agentRoutes.policyRevision} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(agentRoutes.id, route.id));
        await tx
          .update(projects)
          .set({
            deploymentId,
            releaseId: deployment.releaseId,
            deploymentStatus: deployment.status,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, projectId));
        const now = new Date();
        const [release] = await tx
          .select()
          .from(releases)
          .where(eq(releases.id, deployment.releaseId))
          .limit(1);
        if (!release) throw new Error("Promoted Deployment has no Release.");
        // Promotion must move the scheduler target inside its own transaction;
        // the effect itself is the ScheduleStore's, shared rather than copied.
        await applySchedulerTargetTx(tx, {
          projectId,
          deploymentId,
          sourceRevisionId: release.sourceRevisionId,
          now,
        });
        return route.hostname;
      });
      return (await domain.findRouteByHostname(hostname))!;
    },

    async ensureAliasRoute(projectId, alias, baseDomain, targets) {
      validateRouteTargets(targets);
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(alias))
        throw new Error("Alias must be a DNS-safe label.");
      const hostname = await db.transaction(async (tx) => {
        const [project] = await tx
          .select()
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        if (!project) throw new Error("Project not found.");
        for (const target of targets) {
          const [deployment] = await tx
            .select()
            .from(deployments)
            .where(eq(deployments.id, target.deploymentId))
            .limit(1);
          if (
            !deployment ||
            deployment.projectId !== projectId ||
            (target.weight > 0 && deployment.status !== "running")
          ) {
            throw new Error("Alias target must be a running deployment in this project.");
          }
        }
        const hostname = `${alias}--${project.slug}.${normalizeBaseDomain(baseDomain)}`;
        const [existing] = await tx
          .select()
          .from(agentRoutes)
          .where(eq(agentRoutes.hostname, hostname))
          .limit(1);
        const [route] = existing
          ? await tx
              .update(agentRoutes)
              .set({
                enabled: true,
                policyRevision: sql`${agentRoutes.policyRevision} + 1`,
                updatedAt: new Date(),
              })
              .where(eq(agentRoutes.id, existing.id))
              .returning()
          : await tx
              .insert(agentRoutes)
              .values({
                id: createId("route"),
                projectId,
                hostname,
                kind: "alias",
              })
              .returning();
        if (!route) throw new Error("Failed to materialize alias route.");
        await tx.delete(routeTargets).where(eq(routeTargets.routeId, route.id));
        await tx
          .insert(routeTargets)
          .values(targets.map((target) => ({ routeId: route.id, ...target })));
        return hostname;
      });
      return (await domain.findRouteByHostname(hostname))!;
    },

    async getDeploymentRetention(projectId, keepRecent = 3, options = {}) {
      const now = options.now ?? new Date();
      const workflowRuns = options.deploymentsWithActiveWorkflowRuns;
      const deploymentList = await domain.listDeployments(projectId);
      const routes = await domain.listProjectRoutes(projectId);
      const targeted = new Set(
        routes
          .filter((route) => route.kind !== "deployment")
          .flatMap((route) => route.targets.map((target) => target.deploymentId)),
      );
      const bindingRows = await db
        .select()
        .from(sessionBindings)
        .where(eq(sessionBindings.projectId, projectId));
      const bindings = bindingRows.map(sessionBindingRowToSessionBinding);
      const sessionRows = await db.select().from(sessions).where(eq(sessions.projectId, projectId));
      const terminalByEveId = new Map(
        sessionRows
          .filter((session) => session.eveSessionId)
          .map((session) => [
            session.eveSessionId!,
            ["completed", "failed"].includes(session.status),
          ]),
      );
      const active = new Set(
        bindings
          .filter(
            (binding) =>
              terminalByEveId.get(binding.eveSessionId) !== true &&
              isSessionBindingActive(binding, now, options),
          )
          .map((binding) => binding.deploymentId),
      );
      const activeLeaseRows =
        deploymentList.length === 0
          ? []
          : await db
              .select({ deploymentId: activationLeases.deploymentId })
              .from(activationLeases)
              .where(
                and(
                  inArray(
                    activationLeases.deploymentId,
                    deploymentList.map((deployment) => deployment.id),
                  ),
                  isNull(activationLeases.releasedAt),
                  gt(activationLeases.expiresAt, now),
                ),
              );
      const activeRequests = new Set(activeLeaseRows.map((lease) => lease.deploymentId));
      const recent = new Set(
        deploymentList.slice(0, keepRecent).map((deployment) => deployment.id),
      );
      return deploymentList.map((deployment) => {
        const reasons: Array<
          | "route_target"
          | "active_session"
          | "active_request"
          | "recent_artifact"
          | "active_workflow_run"
        > = [];
        if (targeted.has(deployment.id)) reasons.push("route_target");
        if (active.has(deployment.id)) reasons.push("active_session");
        if (activeRequests.has(deployment.id)) reasons.push("active_request");
        if (recent.has(deployment.id)) reasons.push("recent_artifact");
        // A sleeping run holds no session, no lease and no route, so every
        // other reason above misses it. Its deployment is nonetheless the only
        // one that can resume it.
        if (workflowRuns?.has(deployment.id)) reasons.push("active_workflow_run");
        return { deployment, protected: reasons.length > 0, reasons };
      });
    },

    async findSessionBinding(projectId, eveSessionId) {
      const [binding] = await db
        .select()
        .from(sessionBindings)
        .where(
          and(
            eq(sessionBindings.projectId, projectId),
            eq(sessionBindings.eveSessionId, eveSessionId),
          ),
        )
        .limit(1);
      return binding ? sessionBindingRowToSessionBinding(binding) : null;
    },

    async findSessionBindingByContinuationToken(projectId, continuationToken) {
      const [binding] = await db
        .select()
        .from(sessionBindings)
        .where(
          and(
            eq(sessionBindings.projectId, projectId),
            eq(sessionBindings.continuationToken, continuationToken),
          ),
        )
        .limit(1);
      return binding ? sessionBindingRowToSessionBinding(binding) : null;
    },

    async bindSession(input) {
      return db.transaction(async (tx) => {
        const continuationToken = input.continuationToken ?? null;
        if (continuationToken !== null) {
          await tx
            .update(sessionBindings)
            .set({ continuationToken: null, updatedAt: new Date() })
            .where(
              and(
                eq(sessionBindings.projectId, input.projectId),
                eq(sessionBindings.continuationToken, continuationToken),
                ne(sessionBindings.eveSessionId, input.eveSessionId),
              ),
            );
        }
        const [binding] = await tx
          .insert(sessionBindings)
          .values({ id: createId("bind"), ...input, continuationToken })
          .onConflictDoUpdate({
            target: [sessionBindings.projectId, sessionBindings.eveSessionId],
            set: { ...input, continuationToken, updatedAt: new Date() },
          })
          .returning();
        if (!binding) throw new Error("Failed to persist the Gateway SessionBinding.");
        await tx
          .update(sessions)
          .set({
            trigger: input.trigger,
            routeId: input.routeId,
            experimentId: input.experimentId,
            variantName: input.variantName,
            deploymentId: input.deploymentId,
            continuationToken,
          })
          .where(
            and(
              eq(sessions.projectId, input.projectId),
              eq(sessions.eveSessionId, input.eveSessionId),
            ),
          );
        return sessionBindingRowToSessionBinding(binding);
      });
    },

    async setSessionBindingContinuationToken(
      projectId,
      eveSessionId,
      continuationToken,
      now = new Date(),
    ) {
      return db.transaction(async (tx) => {
        if (continuationToken !== null) {
          await tx
            .update(sessionBindings)
            .set({ continuationToken: null, updatedAt: now })
            .where(
              and(
                eq(sessionBindings.projectId, projectId),
                eq(sessionBindings.continuationToken, continuationToken),
                ne(sessionBindings.eveSessionId, eveSessionId),
              ),
            );
        }
        const [binding] = await tx
          .update(sessionBindings)
          .set({ continuationToken, updatedAt: now })
          .where(
            and(
              eq(sessionBindings.projectId, projectId),
              eq(sessionBindings.eveSessionId, eveSessionId),
            ),
          )
          .returning();
        if (!binding) return null;
        await tx
          .update(sessions)
          .set({ continuationToken })
          .where(and(eq(sessions.projectId, projectId), eq(sessions.eveSessionId, eveSessionId)));
        return sessionBindingRowToSessionBinding(binding);
      });
    },

    async touchSessionBinding(projectId, eveSessionId, now = new Date()) {
      const [binding] = await db
        .update(sessionBindings)
        .set({ updatedAt: now })
        .where(
          and(
            eq(sessionBindings.projectId, projectId),
            eq(sessionBindings.eveSessionId, eveSessionId),
          ),
        )
        .returning();
      return binding ? sessionBindingRowToSessionBinding(binding) : null;
    },
  };

  return domain;
}
