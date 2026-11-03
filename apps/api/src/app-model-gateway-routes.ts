import { toPublicJob } from "@evelandhq/core/jobs";
import {
  MODEL_GATEWAY_KINDS,
  PROJECT_MODEL_GATEWAY_MODES,
  isModelGatewayKind,
  isProjectModelGatewayMode,
  type ModelGatewayKind,
} from "@evelandhq/core/model-gateway";
import type { Store } from "@evelandhq/db";
import type { ApiApp } from "./app-types.js";

type ModelGatewayRouteStore = Pick<
  Store,
  | "deleteModelGateway"
  | "enqueueJob"
  | "getModelGateway"
  | "getProject"
  | "getProjectModelGateway"
  | "listDeployments"
  | "listProjectModelGateways"
  | "listProjects"
  | "saveModelGateway"
  | "saveProjectModelGatewayMode"
>;

/**
 * The instance's Model Gateway (admin-only: every `/api/platform/*` route sits
 * behind the admin boundary) and whether each project uses it (a Team
 * member's project setting, like its environment).
 *
 * The gateway is only an address: Eveland holds no credential for it, and each
 * project supplies its own AI_GATEWAY_API_KEY. A change restarts the live
 * Deployments it affects, onto their existing Releases, the way an
 * environment change does.
 */
export function registerModelGatewayRoutes(input: {
  app: ApiApp;
  store: ModelGatewayRouteStore;
}): void {
  const { app, store } = input;

  app.get("/api/platform/model-gateway", async (c) => {
    return c.json({ gateway: await store.getModelGateway() });
  });

  app.put("/api/platform/model-gateway", async (c) => {
    const parsed = parseGatewayInput(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const { gateway, changed } = await store.saveModelGateway(parsed);
    const jobs = changed ? await restartProjectsUsingGateway(store) : [];
    return c.json({ gateway, jobs: jobs.map(toPublicJob) });
  });

  app.delete("/api/platform/model-gateway", async (c) => {
    const deleted = await store.deleteModelGateway();
    const jobs = deleted ? await restartProjectsUsingGateway(store) : [];
    return c.json({ deleted, jobs: jobs.map(toPublicJob) });
  });

  app.get("/api/projects/:projectId/model-gateway", async (c) => {
    const projectId = c.req.param("projectId");
    if (!(await store.getProject(projectId))) return c.json({ error: "Project not found" }, 404);
    const [settings, gateway] = await Promise.all([
      store.getProjectModelGateway(projectId),
      store.getModelGateway(),
    ]);
    return c.json({
      settings,
      gateway: gateway === null ? null : { kind: gateway.kind, baseUrl: gateway.baseUrl },
    });
  });

  app.put("/api/projects/:projectId/model-gateway", async (c) => {
    const projectId = c.req.param("projectId");
    if (!(await store.getProject(projectId))) return c.json({ error: "Project not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const mode = body?.mode;
    if (!isProjectModelGatewayMode(mode)) {
      return c.json(
        { error: `mode must be one of ${PROJECT_MODEL_GATEWAY_MODES.join(", ")}.` },
        400,
      );
    }
    const { setting, changed } = await store.saveProjectModelGatewayMode(projectId, mode);
    const jobs = changed ? await restartLiveDeployments(store, projectId) : [];
    return c.json({ settings: setting, jobs: jobs.map(toPublicJob) });
  });
}

function parseGatewayInput(
  body: unknown,
): { kind: ModelGatewayKind; baseUrl: string } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "Expected a JSON object." };
  const { kind, baseUrl } = body as Record<string, unknown>;
  if (!isModelGatewayKind(kind)) {
    return { error: `kind must be one of ${MODEL_GATEWAY_KINDS.join(", ")}.` };
  }
  if (typeof baseUrl !== "string" || !isHttpUrl(baseUrl.trim())) {
    return { error: "baseUrl must be an http(s) URL without credentials." };
  }
  return { kind, baseUrl: trimTrailingSlashes(baseUrl.trim()) };
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

/** Drops trailing slashes without a regex (`/\/+$/` backtracks polynomially). */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
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
    (await store.listProjectModelGateways())
      .filter((setting) => setting.mode === "off")
      .map((setting) => setting.projectId),
  );
  const projects = (await store.listProjects()).filter((project) => !optedOut.has(project.id));
  return (
    await Promise.all(projects.map((project) => restartLiveDeployments(store, project.id)))
  ).flat();
}
