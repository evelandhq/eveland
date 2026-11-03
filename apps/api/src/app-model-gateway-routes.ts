import { toPublicJob } from "@evelandhq/core/jobs";
import {
  MODEL_GATEWAY_KINDS,
  PROJECT_MODEL_GATEWAY_MODES,
  isModelGatewayKind,
  isProjectModelGatewayMode,
  modelGatewayModelsBaseUrl,
  modelGatewayNeedsBaseUrl,
  type ModelGatewayKind,
  type ModelGatewayRebuildRequired,
} from "@evelandhq/core/model-gateway";
import { listGatewayModelIds } from "@evelandhq/core/server/model-gateway-client";
import type { Store } from "@evelandhq/db";
import type { ApiApp } from "./app-types.js";

type ModelGatewayRouteStore = Pick<
  Store,
  | "deleteModelGateway"
  | "enqueueJob"
  | "getModelGateway"
  | "getProject"
  | "getProjectModelGateway"
  | "getRelease"
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
 * project supplies its own AI_GATEWAY_API_KEY. The admin's connection test
 * takes a key in the request and keeps it nowhere. A change restarts the live
 * Deployments it affects, onto their existing Releases, the way an
 * environment change does.
 *
 * A restart can only reconfigure the provider a Release already carries. A
 * live Deployment whose Release has none (built before the provider existed,
 * or on eve 0.83) is not restarted; while its project is set to use the
 * gateway it is reported in `rebuildRequired`, since only a redeploy applies
 * the gateway to it.
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
    const applied = changed
      ? await applyToProjectsUsingGateway(store, { gatewayActive: true })
      : { jobs: [], rebuildRequired: [] };
    return c.json({ gateway, ...publicApplied(applied) });
  });

  app.delete("/api/platform/model-gateway", async (c) => {
    const deleted = await store.deleteModelGateway();
    const applied = deleted
      ? await applyToProjectsUsingGateway(store, { gatewayActive: false })
      : { jobs: [], rebuildRequired: [] };
    return c.json({ deleted, ...publicApplied(applied) });
  });

  app.post("/api/platform/model-gateway/test", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = parseGatewayInput(body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const key = (body as Record<string, unknown>).key;
    if (typeof key !== "string" || key.trim() === "") {
      return c.json({ error: "Enter a key to test the gateway with." }, 400);
    }
    try {
      const models = await listGatewayModelIds({
        baseUrl: modelGatewayModelsBaseUrl(parsed),
        apiKey: key.trim(),
      });
      return c.json({ result: { ok: true, modelCount: models.length } });
    } catch (error) {
      // The client masks the key out of every message it builds.
      const message = error instanceof Error ? error.message : "The connection test failed.";
      return c.json({ result: { ok: false, error: message } });
    }
  });

  app.get("/api/projects/:projectId/model-gateway", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    const [settings, gateway] = await Promise.all([
      store.getProjectModelGateway(projectId),
      store.getModelGateway(),
    ]);
    const rebuildRequired =
      gateway !== null && settings.mode === "platform"
        ? (await partitionLiveDeployments(store, project)).withoutProvider
        : [];
    return c.json({
      settings,
      gateway: gateway === null ? null : { kind: gateway.kind, baseUrl: gateway.baseUrl },
      rebuildRequired,
    });
  });

  app.put("/api/projects/:projectId/model-gateway", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const mode = body?.mode;
    if (!isProjectModelGatewayMode(mode)) {
      return c.json(
        { error: `mode must be one of ${PROJECT_MODEL_GATEWAY_MODES.join(", ")}.` },
        400,
      );
    }
    const { setting, changed } = await store.saveProjectModelGatewayMode(projectId, mode);
    const applied = changed
      ? await applyToLiveDeployments(store, project, {
          gatewayActive: mode === "platform" && (await store.getModelGateway()) !== null,
        })
      : { jobs: [], rebuildRequired: [] };
    return c.json({ settings: setting, ...publicApplied(applied) });
  });
}

function parseGatewayInput(
  body: unknown,
): { kind: ModelGatewayKind; baseUrl: string | null } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "Expected a JSON object." };
  const { kind, baseUrl } = body as Record<string, unknown>;
  if (!isModelGatewayKind(kind)) {
    return { error: `kind must be one of ${MODEL_GATEWAY_KINDS.join(", ")}.` };
  }
  if (!modelGatewayNeedsBaseUrl(kind)) {
    if (baseUrl !== undefined && baseUrl !== null && baseUrl !== "") {
      return { error: "baseUrl is fixed for Vercel AI Gateway and must be omitted." };
    }
    return { kind, baseUrl: null };
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

type ProjectRef = { id: string; name: string };
type QueuedJob = Awaited<ReturnType<ModelGatewayRouteStore["enqueueJob"]>>;
type Applied = { jobs: QueuedJob[]; rebuildRequired: ModelGatewayRebuildRequired[] };

function publicApplied(applied: Applied) {
  return { jobs: applied.jobs.map(toPublicJob), rebuildRequired: applied.rebuildRequired };
}

/** A project's live Deployments, split by whether their Release carries the provider. */
async function partitionLiveDeployments(store: ModelGatewayRouteStore, project: ProjectRef) {
  const live = (await store.listDeployments(project.id)).filter(
    (deployment) => deployment.status === "running" || deployment.status === "draining",
  );
  const releases = await Promise.all(
    live.map((deployment) => store.getRelease(deployment.releaseId)),
  );
  const withProvider: typeof live = [];
  const withoutProvider: ModelGatewayRebuildRequired[] = [];
  live.forEach((deployment, index) => {
    if (releases[index]?.modelGatewayProvider) {
      withProvider.push(deployment);
    } else {
      withoutProvider.push({
        projectId: project.id,
        projectName: project.name,
        deploymentId: deployment.id,
        deploymentKey: deployment.deploymentKey,
      });
    }
  });
  return { withProvider, withoutProvider };
}

/**
 * Restarts the live Deployments a restart can reconfigure. The rest keep
 * calling models as authored, which is a rebuild requirement only when the
 * project is now set to use a gateway.
 */
async function applyToLiveDeployments(
  store: ModelGatewayRouteStore,
  project: ProjectRef,
  options: { gatewayActive: boolean },
): Promise<Applied> {
  const { withProvider, withoutProvider } = await partitionLiveDeployments(store, project);
  const jobs = await Promise.all(
    withProvider.map((deployment) =>
      store.enqueueJob(project.id, "restart_deployment", {
        deploymentId: deployment.id,
        reason: "model_gateway_changed",
      }),
    ),
  );
  return { jobs, rebuildRequired: options.gatewayActive ? withoutProvider : [] };
}

/** Every project except those that opted out of the platform gateway. */
async function applyToProjectsUsingGateway(
  store: ModelGatewayRouteStore,
  options: { gatewayActive: boolean },
): Promise<Applied> {
  const optedOut = new Set(
    (await store.listProjectModelGateways())
      .filter((setting) => setting.mode === "off")
      .map((setting) => setting.projectId),
  );
  const projects = (await store.listProjects()).filter((project) => !optedOut.has(project.id));
  const applied = await Promise.all(
    projects.map((project) => applyToLiveDeployments(store, project, options)),
  );
  return {
    jobs: applied.flatMap((entry) => entry.jobs),
    rebuildRequired: applied.flatMap((entry) => entry.rebuildRequired),
  };
}
