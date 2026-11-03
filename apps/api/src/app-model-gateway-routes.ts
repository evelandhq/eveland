import { toPublicJob } from "@evelandhq/core/jobs";
import {
  isModelGatewayKind,
  isProjectModelGatewayMode,
  modelGatewayIssuesProjectKeys,
  modelGatewayIdentity,
  modelGatewayNeedsBaseUrl,
  projectModelGatewayToPublic,
  type ModelGatewayKind,
} from "@evelandhq/core/model-gateway";
import { testModelGatewayConnection } from "@evelandhq/core/server/model-gateway-client";
import {
  decryptSecretValue,
  encryptSecretValue,
  type EncryptedSecret,
} from "@evelandhq/core/server/secrets";
import type { Store } from "@evelandhq/db";
import type { ApiApp } from "./app-types.js";

type ModelGatewayRouteStore = Pick<
  Store,
  | "deleteModelGateway"
  | "enqueueJob"
  | "getModelGatewayRecord"
  | "getProject"
  | "getProjectModelGatewayRecord"
  | "listDeployments"
  | "listProjectModelGatewayRecords"
  | "listProjects"
  | "saveModelGateway"
  | "saveProjectModelGatewaySettings"
>;

/**
 * The instance's Model Gateway (admin-only: every `/api/platform/*` route sits
 * behind the admin boundary) and each project's use of it (a Team member's
 * project setting, like its secrets).
 *
 * Credentials and keys go in, never out: responses carry only whether one is
 * configured. A change restarts the live Deployments it affects, onto their
 * existing Releases, the way an environment change does.
 */
export function registerModelGatewayRoutes(input: {
  app: ApiApp;
  store: ModelGatewayRouteStore;
  appSecretKey: string;
  testConnection?: typeof testModelGatewayConnection;
}): void {
  const { app, store, appSecretKey } = input;
  const testConnection = input.testConnection ?? testModelGatewayConnection;
  const encrypt = (value: string) => JSON.stringify(encryptSecretValue(value, appSecretKey));
  const decrypt = (value: string) =>
    decryptSecretValue(JSON.parse(value) as EncryptedSecret, appSecretKey);

  app.get("/api/platform/model-gateway", async (c) => {
    const record = await store.getModelGatewayRecord();
    if (record === null) return c.json({ gateway: null });
    const { encryptedCredential: _credential, ...gateway } = record;
    return c.json({ gateway: { ...gateway, credentialConfigured: true } });
  });

  app.put("/api/platform/model-gateway", async (c) => {
    const parsed = parseGatewayInput(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const existing = await store.getModelGatewayRecord();
    const sameGateway =
      existing !== null && modelGatewayIdentity(existing) === modelGatewayIdentity(parsed);
    if (parsed.credential === undefined && !sameGateway) {
      return c.json(
        {
          error:
            "A credential is required for a new Model Gateway, or when its kind or base URL changes.",
        },
        400,
      );
    }
    const { gateway, changed } = await store.saveModelGateway({
      kind: parsed.kind,
      baseUrl: parsed.baseUrl,
      encryptedCredential:
        parsed.credential === undefined
          ? existing!.encryptedCredential
          : encrypt(parsed.credential),
    });
    const jobs = changed ? await restartProjectsUsingGateway(store) : [];
    return c.json({ gateway, jobs: jobs.map(toPublicJob) });
  });

  app.delete("/api/platform/model-gateway", async (c) => {
    const deleted = await store.deleteModelGateway();
    const jobs = deleted ? await restartProjectsUsingGateway(store) : [];
    return c.json({ deleted, jobs: jobs.map(toPublicJob) });
  });

  app.post("/api/platform/model-gateway/test", async (c) => {
    const parsed = parseGatewayInput(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    let credential = parsed.credential;
    if (credential === undefined) {
      // The stored credential is only ever sent to the gateway it belongs to.
      const existing = await store.getModelGatewayRecord();
      if (existing === null || modelGatewayIdentity(existing) !== modelGatewayIdentity(parsed)) {
        return c.json({ error: "Enter a credential to test a new or changed Model Gateway." }, 400);
      }
      credential = decrypt(existing.encryptedCredential);
    }
    const result = await testConnection({ kind: parsed.kind, baseUrl: parsed.baseUrl, credential });
    return c.json({ result });
  });

  app.get("/api/projects/:projectId/model-gateway", async (c) => {
    const projectId = c.req.param("projectId");
    if (!(await store.getProject(projectId))) return c.json({ error: "Project not found" }, 404);
    const [record, gateway] = await Promise.all([
      store.getProjectModelGatewayRecord(projectId),
      store.getModelGatewayRecord(),
    ]);
    return c.json({
      settings: projectModelGatewayToPublic(record),
      gateway:
        gateway === null
          ? null
          : { kind: gateway.kind, issuesProjectKeys: modelGatewayIssuesProjectKeys(gateway.kind) },
    });
  });

  app.put("/api/projects/:projectId/model-gateway", async (c) => {
    const projectId = c.req.param("projectId");
    if (!(await store.getProject(projectId))) return c.json({ error: "Project not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const mode = body?.mode;
    const projectKey = body?.projectKey;
    if (!isProjectModelGatewayMode(mode)) {
      return c.json({ error: "mode must be one of platform, project-key, off." }, 400);
    }
    if (projectKey !== undefined && (typeof projectKey !== "string" || projectKey.trim() === "")) {
      return c.json({ error: "projectKey must be a non-empty string." }, 400);
    }
    const existing = await store.getProjectModelGatewayRecord(projectId);
    if (
      mode === "project-key" &&
      projectKey === undefined &&
      existing.encryptedProjectKey === null
    ) {
      return c.json({ error: "Enter the project's Model Gateway key to use its own key." }, 400);
    }
    const saved = await store.saveProjectModelGatewaySettings(projectId, {
      mode,
      // The project's own key exists only while the project uses it.
      encryptedProjectKey:
        mode !== "project-key"
          ? null
          : projectKey === undefined
            ? existing.encryptedProjectKey
            : encrypt(projectKey.trim()),
    });
    const changed =
      saved.mode !== existing.mode || saved.encryptedProjectKey !== existing.encryptedProjectKey;
    const jobs = changed ? await restartLiveDeployments(store, projectId) : [];
    return c.json({ settings: projectModelGatewayToPublic(saved), jobs: jobs.map(toPublicJob) });
  });

  app.post("/api/projects/:projectId/model-gateway/rotate", async (c) => {
    const projectId = c.req.param("projectId");
    if (!(await store.getProject(projectId))) return c.json({ error: "Project not found" }, 404);
    const [record, gateway] = await Promise.all([
      store.getProjectModelGatewayRecord(projectId),
      store.getModelGatewayRecord(),
    ]);
    if (
      gateway === null ||
      record.mode !== "platform" ||
      record.issuedKey?.state !== "registered" ||
      record.issuedKey.gatewayIdentity !== modelGatewayIdentity(gateway)
    ) {
      return c.json(
        { error: "This project has no Eveland-issued key on the current Model Gateway to rotate." },
        409,
      );
    }
    const job = await store.enqueueJob(projectId, "rotate_model_gateway_key", {});
    return c.json({ job: toPublicJob(job) }, 202);
  });
}

type GatewayInput = {
  kind: ModelGatewayKind;
  baseUrl: string | null;
  credential: string | undefined;
};

function parseGatewayInput(body: unknown): GatewayInput | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "Expected a JSON object." };
  const { kind, baseUrl, credential } = body as Record<string, unknown>;
  if (!isModelGatewayKind(kind)) {
    return { error: "kind must be one of vercel, openrouter, litellm, openai-compatible." };
  }
  if (credential !== undefined && (typeof credential !== "string" || credential.trim() === "")) {
    return { error: "credential must be a non-empty string." };
  }
  const trimmedCredential = typeof credential === "string" ? credential.trim() : undefined;
  if (!modelGatewayNeedsBaseUrl(kind)) {
    if (baseUrl !== undefined && baseUrl !== null && baseUrl !== "") {
      return { error: "baseUrl is fixed for the vercel kind and must be omitted." };
    }
    return { kind, baseUrl: null, credential: trimmedCredential };
  }
  if (typeof baseUrl !== "string" || !isHttpUrl(baseUrl.trim())) {
    return { error: "baseUrl must be an http(s) URL for this kind." };
  }
  return { kind, baseUrl: baseUrl.trim().replace(/\/+$/, ""), credential: trimmedCredential };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

async function restartLiveDeployments(store: ModelGatewayRouteStore, projectId: string) {
  const live = (await store.listDeployments(projectId)).filter(
    (deployment) => deployment.status === "running" || deployment.status === "draining",
  );
  return Promise.all(
    live.map((deployment) =>
      store.enqueueJob(projectId, "restart_deployment", {
        deploymentId: deployment.id,
        reason: "model_gateway_changed",
      }),
    ),
  );
}

/** Every project except those that opted out of the platform gateway. */
async function restartProjectsUsingGateway(store: ModelGatewayRouteStore) {
  const optedOut = new Set(
    (await store.listProjectModelGatewayRecords())
      .filter((record) => record.mode === "off")
      .map((record) => record.projectId),
  );
  const projects = (await store.listProjects()).filter((project) => !optedOut.has(project.id));
  return (
    await Promise.all(projects.map((project) => restartLiveDeployments(store, project.id)))
  ).flat();
}
