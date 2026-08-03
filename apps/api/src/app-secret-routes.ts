import type { Job, SharedAgentEnvironmentRecord } from "@eveland/core/contracts";
import { toPublicJob } from "@eveland/core/jobs";
import { encryptSecretValue } from "@eveland/core/server/secrets";
import type { Store } from "@eveland/db";
import {
  batchSecretSchema,
  secretSchema,
  sharedAgentEnvironmentSchema,
  updateSecretSchema,
} from "./app-schemas.js";
import type { ApiApp } from "./app-types.js";

export function registerSecretRoutes(input: {
  app: ApiApp;
  store: Store;
  appSecretKey: string;
  enqueueLiveDeploymentRestarts(projectId: string): Promise<Job[]>;
}): void {
  const { app, store, appSecretKey, enqueueLiveDeploymentRestarts } = input;

  app.get("/projects/:projectId/secrets", async (c) => {
    return c.json({
      secrets: await store.listSecrets(c.req.param("projectId")),
    });
  });

  app.post("/projects/:projectId/secrets", async (c) => {
    const parsed = secretSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid secret input", issues: parsed.error.issues }, 400);
    }
    const encrypted = encryptSecretValue(parsed.data.value, appSecretKey);
    const projectId = c.req.param("projectId");
    const secret = await store.upsertSecret(
      projectId,
      parsed.data.key,
      JSON.stringify(encrypted),
      parsed.data.kind,
    );
    const jobs = await enqueueLiveDeploymentRestarts(projectId);
    return c.json({ secret, jobs: jobs.map(toPublicJob) }, 201);
  });

  app.post("/projects/:projectId/secrets/batch", async (c) => {
    const parsed = batchSecretSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: "Invalid project environment batch", issues: parsed.error.issues },
        400,
      );
    }

    const projectId = c.req.param("projectId");
    const existing = await store.listSecrets(projectId);
    const resultingKeys = new Set(existing.map((entry) => entry.key));
    parsed.data.entries.forEach((entry) => resultingKeys.add(entry.key));
    if (resultingKeys.size > 50) {
      return c.json(
        {
          error: "A project can have at most 50 environment entries.",
          issues: [
            {
              code: "custom",
              path: ["entries"],
              message: "Remove an existing entry or import fewer new names.",
            },
          ],
        },
        400,
      );
    }

    const secrets = await store.upsertSecrets(
      projectId,
      parsed.data.entries.map((entry) => ({
        key: entry.key,
        kind: entry.kind,
        value: JSON.stringify(encryptSecretValue(entry.value, appSecretKey)),
      })),
    );
    const jobs = await enqueueLiveDeploymentRestarts(projectId);
    return c.json({ secrets, jobs: jobs.map(toPublicJob) }, 201);
  });

  app.put("/projects/:projectId/secrets/:secretId", async (c) => {
    const parsed = updateSecretSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Invalid environment entry input", issues: parsed.error.issues }, 400);
    }
    const projectId = c.req.param("projectId");
    const secret = await store.updateSecret(projectId, c.req.param("secretId"), {
      key: parsed.data.key,
      kind: parsed.data.kind,
      ...(parsed.data.value !== undefined
        ? { encryptedValue: JSON.stringify(encryptSecretValue(parsed.data.value, appSecretKey)) }
        : {}),
    });
    if (!secret) return c.json({ error: "Environment entry not found" }, 404);
    const jobs = await enqueueLiveDeploymentRestarts(projectId);
    return c.json({ secret, jobs: jobs.map(toPublicJob) });
  });

  app.delete("/projects/:projectId/secrets/:secretId", async (c) => {
    const projectId = c.req.param("projectId");
    const deleted = await store.deleteSecret(projectId, c.req.param("secretId"));
    const jobs = deleted ? await enqueueLiveDeploymentRestarts(projectId) : [];
    return c.json({ deleted, jobs: jobs.map(toPublicJob) });
  });

  app.get("/platform/shared-agent-environment", async (c) => {
    const record = await store.getSharedAgentEnvironmentRecord();
    return c.json({
      environment: record ? publicSharedAgentEnvironment(record) : null,
    });
  });

  app.put("/platform/shared-agent-environment", async (c) => {
    const parsed = sharedAgentEnvironmentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: "Invalid shared Agent environment", issues: parsed.error.issues },
        400,
      );
    }
    const existing = await store.getSharedAgentEnvironmentRecord();
    const entries = parsed.data.entries.map((entry) => {
      const previous = existing?.entries.find(
        (candidate) => candidate.key === entry.key && candidate.kind === entry.kind,
      );
      if (entry.value === undefined && !previous) return null;
      return {
        key: entry.key,
        kind: entry.kind,
        encryptedValue:
          entry.value === undefined
            ? previous!.encryptedValue
            : JSON.stringify(encryptSecretValue(entry.value, appSecretKey)),
      };
    });
    if (entries.some((entry) => entry === null)) {
      return c.json(
        { error: "A value is required for every new or changed shared Agent environment entry." },
        400,
      );
    }
    const previousRevision = existing?.revision ?? 0;
    const environment = await store.saveSharedAgentEnvironment({
      entries: entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    });
    const jobs =
      environment.revision === previousRevision
        ? []
        : await enqueueAllLiveDeploymentRestarts(store);
    return c.json({ environment, jobs: jobs.map(toPublicJob) });
  });
}

async function enqueueAllLiveDeploymentRestarts(store: Store) {
  const projects = await store.listProjects();
  const targets = (
    await Promise.all(
      projects.map(async (project) =>
        (await store.listDeployments(project.id))
          .filter(
            (deployment) => deployment.status === "running" || deployment.status === "draining",
          )
          .map((deployment) => ({ projectId: project.id, deploymentId: deployment.id })),
      ),
    )
  ).flat();
  return Promise.all(
    targets.map((target) =>
      store.enqueueJob(target.projectId, "restart_deployment", {
        deploymentId: target.deploymentId,
        reason: "shared_agent_environment_changed",
      }),
    ),
  );
}

function publicSharedAgentEnvironment(record: SharedAgentEnvironmentRecord) {
  return {
    revision: record.revision,
    entries: record.entries.map(({ key, kind }) => ({ key, kind, configured: true as const })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
