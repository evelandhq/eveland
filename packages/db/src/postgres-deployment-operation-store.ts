import type { DeploymentOperation } from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import { and, eq } from "drizzle-orm";
import {
  deploymentOperations,
  jobs,
  projects,
  sourcePreflights,
} from "./schema.js";
import type {
  PostgresDomain,
  PostgresStoreContext,
} from "./postgres-store-support.js";

type DeploymentOperationRow = typeof deploymentOperations.$inferSelect;

export function createPostgresDeploymentOperationStore({
  db,
}: PostgresStoreContext): PostgresDomain {
  return {
    async createDeploymentOperationFromSourcePreflight(input) {
      return db.transaction(async (tx) => {
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, input.projectId))
          .limit(1);
        if (!project) return { outcome: "not_found" as const };

        const [preflight] = await tx
          .select()
          .from(sourcePreflights)
          .where(
            and(
              eq(sourcePreflights.id, input.sourcePreflightId),
              eq(sourcePreflights.userId, input.requestedByUserId),
            ),
          )
          .limit(1)
          .for("update");
        if (!preflight) return { outcome: "not_found" as const };
        if (preflight.status === "consumed")
          return { outcome: "consumed" as const };
        if (
          preflight.status !== "completed" ||
          !preflight.sourcePath ||
          preflight.expiresAt.getTime() <= Date.now()
        ) {
          return { outcome: "not_ready" as const };
        }

        const [operation] = await tx
          .insert(deploymentOperations)
          .values({
            id: createId("dop"),
            projectId: project.id,
            requestedByUserId: input.requestedByUserId,
            target: input.target,
            status: "importing",
            sourceDigest: input.sourceDigest,
            gitMetadata: input.git ?? null,
          })
          .returning();
        if (!operation)
          throw new Error("Failed to create Deployment Operation.");

        const consumed = await tx
          .update(sourcePreflights)
          .set({ status: "consumed", updatedAt: new Date() })
          .where(
            and(
              eq(sourcePreflights.id, preflight.id),
              eq(sourcePreflights.status, "completed"),
            ),
          )
          .returning({ id: sourcePreflights.id });
        if (consumed.length !== 1)
          throw new Error("Failed to consume Source Preflight.");

        await tx.insert(jobs).values({
          id: createId("job"),
          projectId: project.id,
          type: "import_source",
          status: "queued",
          payload: {
            operationId: operation.id,
            importKind: "zip",
            sourcePath: preflight.sourcePath,
            sourceRevisionKind: "local",
            deployAfterImport: true,
            promoteAfterDeploy: input.target === "production",
          },
        });

        return {
          outcome: "created" as const,
          operation: deploymentOperationRowToOperation(operation),
        };
      });
    },

    async getDeploymentOperation(operationId) {
      const [row] = await db
        .select()
        .from(deploymentOperations)
        .where(eq(deploymentOperations.id, operationId))
        .limit(1);
      return row ? deploymentOperationRowToOperation(row) : null;
    },

    async updateDeploymentOperation(operationId, input) {
      const [row] = await db
        .update(deploymentOperations)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(deploymentOperations.id, operationId))
        .returning();
      return row ? deploymentOperationRowToOperation(row) : null;
    },
  };
}

function deploymentOperationRowToOperation(
  row: DeploymentOperationRow,
): DeploymentOperation {
  const git = isGitMetadata(row.gitMetadata) ? row.gitMetadata : null;
  return {
    id: row.id,
    projectId: row.projectId,
    requestedByUserId: row.requestedByUserId,
    target: row.target as DeploymentOperation["target"],
    status: row.status as DeploymentOperation["status"],
    sourceDigest: row.sourceDigest,
    git,
    sourceRevisionId: row.sourceRevisionId,
    releaseId: row.releaseId,
    deploymentId: row.deploymentId,
    previewHostname: row.previewHostname,
    productionHostname: row.productionHostname,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isGitMetadata(
  value: unknown,
): value is NonNullable<DeploymentOperation["git"]> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (typeof candidate.commitSha === "string" || candidate.commitSha === null) &&
    (typeof candidate.branch === "string" || candidate.branch === null) &&
    typeof candidate.dirty === "boolean"
  );
}
