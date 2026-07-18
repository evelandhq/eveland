import { encryptSecretValue } from "@eveland/core/server/secrets";
import type { Store } from "@eveland/db";
import type { ApiApp, AppOptions } from "./app-types.js";
import {
  platformSecretBindingSchema,
  platformSecretConsumerSchema,
  platformSecretProfileSchema,
  secretSchema,
  sharedAgentEnvironmentBindingSchema,
  sharedAgentEnvironmentSchema,
} from "./app-schemas.js";
import type {
  PlatformSecretProfileBinding,
  SharedAgentEnvironmentBinding,
  SharedAgentEnvironmentRecord,
} from "@eveland/core/contracts";
import { SHARED_AGENT_ENVIRONMENT_PROFILE_ID } from "@eveland/core/contracts";

type PlatformSecretRestart = (
  bindings: Array<PlatformSecretProfileBinding | SharedAgentEnvironmentBinding>,
  reason:
    | "platform_secret_binding_changed"
    | "platform_secret_profile_changed"
    | "shared_agent_environment_binding_changed"
    | "shared_agent_environment_changed",
) => Promise<unknown>;

export function registerSecretRoutes(input: {
  app: ApiApp;
  store: Store;
  options: Pick<AppOptions, "auth">;
  appSecretKey: string;
  enqueueLiveDeploymentRestarts(projectId: string): Promise<unknown>;
  enqueuePlatformSecretRestarts: PlatformSecretRestart;
}): void {
  const {
    app,
    store,
    options,
    appSecretKey,
    enqueueLiveDeploymentRestarts,
    enqueuePlatformSecretRestarts,
  } = input;
  app.get("/projects/:projectId/secrets", async (c) => {
    return c.json({
      secrets: await store.listSecrets(c.req.param("projectId")),
    });
  });

  app.post("/projects/:projectId/secrets", async (c) => {
    const parsed = secretSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "Invalid secret input", issues: parsed.error.issues },
        400,
      );
    }
    const encrypted = encryptSecretValue(parsed.data.value, appSecretKey);
    const projectId = c.req.param("projectId");
    const secret = await store.upsertSecret(
      projectId,
      parsed.data.key,
      JSON.stringify(encrypted),
    );
    const jobs = await enqueueLiveDeploymentRestarts(projectId);
    return c.json({ secret, jobs }, 201);
  });

  app.delete("/projects/:projectId/secrets/:secretId", async (c) => {
    const projectId = c.req.param("projectId");
    const deleted = await store.deleteSecret(
      projectId,
      c.req.param("secretId"),
    );
    const jobs = deleted ? await enqueueLiveDeploymentRestarts(projectId) : [];
    return c.json({ deleted, jobs });
  });

  app.get("/platform/shared-agent-environment", async (c) => {
    if (options.auth && c.get("principal").role !== "admin")
      return c.json({ error: "Admin access required" }, 403);
    const record = await store.getSharedAgentEnvironmentRecord();
    return c.json({
      environment: record ? publicSharedAgentEnvironment(record) : null,
    });
  });

  app.put("/platform/shared-agent-environment", async (c) => {
    if (options.auth && c.get("principal").role !== "admin")
      return c.json({ error: "Admin access required" }, 403);
    const parsed = sharedAgentEnvironmentSchema.safeParse(
      await c.req.json().catch(() => null),
    );
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
        encryptedValue: entry.value === undefined
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
    const jobs = environment.revision === previousRevision
      ? []
      : await enqueuePlatformSecretRestarts(
          await store.listSharedAgentEnvironmentBindings(),
          "shared_agent_environment_changed",
        );
    return c.json({ environment, jobs });
  });

  app.get("/projects/:projectId/shared-agent-environment-bindings", async (c) => {
    const project = await store.getProject(c.req.param("projectId"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    return c.json({
      bindings: await store.listProjectSharedAgentEnvironmentBindings(project.id),
    });
  });

  app.put("/projects/:projectId/shared-agent-environment-bindings", async (c) => {
    if (options.auth && c.get("principal").role !== "admin")
      return c.json({ error: "Admin access required" }, 403);
    const parsed = sharedAgentEnvironmentBindingSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid shared Agent environment binding" }, 400);
    }
    if (!await store.getSharedAgentEnvironmentRecord()) {
      return c.json({ error: "Configure the shared Agent environment before binding it." }, 409);
    }
    const projectId = c.req.param("projectId");
    const previous = (await store.listProjectSharedAgentEnvironmentBindings(projectId))
      .find((binding) => binding.deploymentId === parsed.data.deploymentId);
    try {
      const binding = await store.bindSharedAgentEnvironment({
        projectId,
        deploymentId: parsed.data.deploymentId,
      });
      const jobs = previous
        ? []
        : await enqueuePlatformSecretRestarts(
            [binding],
            "shared_agent_environment_binding_changed",
          );
      return c.json({ binding, jobs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        { error: message },
        message.includes("not found") ? 404 : 409,
      );
    }
  });

  app.delete(
    "/projects/:projectId/shared-agent-environment-bindings/:bindingId",
    async (c) => {
      if (options.auth && c.get("principal").role !== "admin")
        return c.json({ error: "Admin access required" }, 403);
      const binding = await store.deleteSharedAgentEnvironmentBinding(
        c.req.param("projectId"),
        c.req.param("bindingId"),
      );
      const jobs = binding
        ? await enqueuePlatformSecretRestarts(
            [binding],
            "shared_agent_environment_binding_changed",
          )
        : [];
      return c.json({ deleted: binding !== null, jobs });
    },
  );

  app.get("/platform/secret-profiles", async (c) => {
    if (options.auth && c.get("principal").role !== "admin")
      return c.json({ error: "Admin access required" }, 403);
    return c.json({
      profiles: (await store.listPlatformSecretProfiles()).filter(
        (profile) => profile.id !== SHARED_AGENT_ENVIRONMENT_PROFILE_ID,
      ),
    });
  });

  app.post("/platform/secret-profiles", async (c) => {
    if (options.auth && c.get("principal").role !== "admin")
      return c.json({ error: "Admin access required" }, 403);
    const parsed = platformSecretProfileSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        {
          error: "Invalid Platform Secret Profile",
          issues: parsed.error.issues,
        },
        400,
      );
    if (parsed.data.entries.some((entry) => entry.value === undefined)) {
      return c.json(
        { error: "Every new Platform Secret Profile entry requires a value." },
        400,
      );
    }
    const profile = await store.savePlatformSecretProfile({
      name: parsed.data.name,
      entries: parsed.data.entries.map((entry) => ({
        key: entry.key,
        kind: entry.kind,
        encryptedValue: JSON.stringify(
          encryptSecretValue(entry.value!, appSecretKey),
        ),
      })),
    });
    return c.json({ profile }, 201);
  });

  app.put("/platform/secret-profiles/:profileId", async (c) => {
    if (options.auth && c.get("principal").role !== "admin")
      return c.json({ error: "Admin access required" }, 403);
    if (c.req.param("profileId") === SHARED_AGENT_ENVIRONMENT_PROFILE_ID)
      return c.json({ error: "Platform Secret Profile not found" }, 404);
    const parsed = platformSecretProfileSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        {
          error: "Invalid Platform Secret Profile",
          issues: parsed.error.issues,
        },
        400,
      );
    const existing = await store.getPlatformSecretProfileRecord(
      c.req.param("profileId"),
    );
    if (!existing)
      return c.json({ error: "Platform Secret Profile not found" }, 404);
    const previousRevision = existing.revision;
    const entries = parsed.data.entries.map((entry) => {
      const previous = existing.entries.find(
        (candidate) =>
          candidate.key === entry.key && candidate.kind === entry.kind,
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
        {
          error:
            "A value is required for every new or changed Platform Secret Profile entry.",
        },
        400,
      );
    }
    const profile = await store.savePlatformSecretProfile({
      id: existing.id,
      name: parsed.data.name,
      entries: entries.filter(
        (entry): entry is NonNullable<typeof entry> => entry !== null,
      ),
    });
    const jobs =
      profile.revision === previousRevision
        ? []
        : await enqueuePlatformSecretRestarts(
            await store.listPlatformSecretProfileBindings(profile.id),
            "platform_secret_profile_changed",
          );
    return c.json({ profile, jobs });
  });

  app.delete("/platform/secret-profiles/:profileId", async (c) => {
    if (options.auth && c.get("principal").role !== "admin")
      return c.json({ error: "Admin access required" }, 403);
    const profileId = c.req.param("profileId");
    if (profileId === SHARED_AGENT_ENVIRONMENT_PROFILE_ID)
      return c.json({ error: "Platform Secret Profile not found" }, 404);
    const bindings = await store.listPlatformSecretProfileBindings(profileId);
    const deleted = await store.deletePlatformSecretProfile(profileId);
    const jobs = deleted
      ? await enqueuePlatformSecretRestarts(
          bindings,
          "platform_secret_profile_changed",
        )
      : [];
    return c.json({ deleted, jobs });
  });

  app.get("/projects/:projectId/platform-secret-bindings", async (c) => {
    const project = await store.getProject(c.req.param("projectId"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    return c.json({
      bindings: await store.listProjectPlatformSecretBindings(project.id),
    });
  });

  app.put(
    "/projects/:projectId/platform-secret-bindings/:consumer",
    async (c) => {
      if (options.auth && c.get("principal").role !== "admin")
        return c.json({ error: "Admin access required" }, 403);
      const consumer = platformSecretConsumerSchema.safeParse(
        c.req.param("consumer"),
      );
      const parsed = platformSecretBindingSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!consumer.success || !parsed.success) {
        return c.json(
          { error: "Invalid Platform Secret Profile binding" },
          400,
        );
      }
      const projectId = c.req.param("projectId");
      const previous = (
        await store.listProjectPlatformSecretBindings(projectId)
      ).find(
        (binding) =>
          binding.consumer === consumer.data &&
          binding.deploymentId === parsed.data.deploymentId,
      );
      try {
        const binding = await store.bindPlatformSecretProfile({
          profileId: parsed.data.profileId,
          projectId,
          deploymentId: parsed.data.deploymentId,
          consumer: consumer.data,
        });
        const changed = !previous || previous.profileId !== binding.profileId;
        const jobs = changed
          ? await enqueuePlatformSecretRestarts(
              [binding],
              "platform_secret_binding_changed",
            )
          : [];
        return c.json({ binding, jobs });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json(
          { error: message },
          message.includes("not found") ? 404 : 409,
        );
      }
    },
  );

  app.delete(
    "/projects/:projectId/platform-secret-bindings/:bindingId",
    async (c) => {
      if (options.auth && c.get("principal").role !== "admin")
        return c.json({ error: "Admin access required" }, 403);
      const binding = await store.deletePlatformSecretProfileBinding(
        c.req.param("projectId"),
        c.req.param("bindingId"),
      );
      const jobs = binding
        ? await enqueuePlatformSecretRestarts(
            [binding],
            "platform_secret_binding_changed",
          )
        : [];
      return c.json({ deleted: binding !== null, jobs });
    },
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
