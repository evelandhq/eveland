import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import type { LogRecord } from "@eveland/core/contracts";
import { assertSafeArchivePath } from "@eveland/core/server/archive";
import { encryptSecretValue } from "@eveland/core/server/secrets";
import type { Store } from "@eveland/db";
import type { CollectorHealth } from "@eveland/session-collector/health";
import { z } from "zod";
import {
  runGatewayPlayground,
  type PlaygroundRunEvent,
  type PlaygroundRunner,
} from "./gateway-playground.js";

const execFileAsync = promisify(execFile);

const createProjectSchema = z.object({
  name: z.string().min(1),
  importKind: z.enum(["git", "zip"]),
  gitUrl: z.string().url().optional().nullable(),
});

const secretSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  value: z.string().min(1),
});

const playgroundMessageSchema = z.object({
  message: z.string().min(1),
});

const targetsArraySchema = z.array(z.object({
    deploymentId: z.string().min(1),
    weight: z.number().int().min(0).max(10_000),
    variantName: z.string().min(1).nullable(),
  })).min(1).max(2);

const routeTargetsSchema = z.object({ targets: targetsArraySchema }).superRefine(validateTargetsPayload);
const aliasSchema = z.object({
  alias: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  targets: targetsArraySchema,
}).superRefine(validateTargetsPayload);

function validateTargetsPayload(
  value: { targets: Array<{ deploymentId: string; weight: number }> },
  context: z.RefinementCtx,
): void {
  if (value.targets.reduce((sum, target) => sum + target.weight, 0) !== 10_000) {
    context.addIssue({ code: "custom", path: ["targets"], message: "Route target weights must total 10,000." });
  }
  if (new Set(value.targets.map((target) => target.deploymentId)).size !== value.targets.length) {
    context.addIssue({ code: "custom", path: ["targets"], message: "Route target deployments must be unique." });
  }
}

const devSecretKey = "eveland-dev-secret-key-000000000";

export type AppOptions = {
  playgroundRunner?: PlaygroundRunner;
  dataDir?: string;
  collectorHealth?: () => CollectorHealth;
  gatewayPublicScheme?: "http" | "https";
  gatewayPublicPort?: number | null;
  invalidateGatewayRoutes?: (hostnames: string[]) => Promise<void>;
};

export function createApp(store: Store, options: AppOptions = {}): Hono {
  const app = new Hono();
  const playgroundRunner = options.playgroundRunner ?? runGatewayPlayground;
  const dataDir = options.dataDir ?? process.env.EVELAND_DATA_DIR ?? ".eveland-data";

  app.use(
    "*",
    cors({
      origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
      credentials: true,
    }),
  );

  app.get("/health", (c) => c.json({ ok: true, service: "eveland-api" }));

  app.get("/internal/collector/health", (c) =>
    c.json(
      options.collectorHealth?.() ?? {
        status: "healthy",
        lastProcessedAt: null,
        backlogEvents: 0,
        backlogBytes: 0,
        oldestEventAge: 0,
        quarantinedEvents: 0,
        lastError: null,
        mode: "disabled",
      },
    ),
  );

  app.get("/projects", async (c) => c.json({ projects: await store.listProjects() }));

  app.post("/projects", async (c) => {
    if (isMultipartRequest(c)) {
      return createZipProjectFromUpload(c, store, dataDir);
    }

    const parsed = createProjectSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid project input", issues: parsed.error.issues }, 400);
    }

    const project = await store.createProject(parsed.data);
    return c.json({ project }, 201);
  });

  app.get("/projects/:projectId", async (c) => {
    const project = await store.getProject(c.req.param("projectId"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json({ project });
  });

  app.get("/projects/:projectId/endpoints", async (c) => {
    const routes = await store.listProjectRoutes(c.req.param("projectId"));
    if (routes.length === 0) return c.json({ error: "Agent endpoints not found" }, 404);
    const scheme = options.gatewayPublicScheme ?? (process.env.EVELAND_GATEWAY_PUBLIC_SCHEME === "https" ? "https" : "http");
    const configuredPort = options.gatewayPublicPort ?? Number(process.env.EVELAND_GATEWAY_PUBLIC_PORT ?? (scheme === "http" ? 4080 : 0));
    const suffix = configuredPort ? `:${configuredPort}` : "";
    const url = (hostname: string) => `${scheme}://${hostname}${suffix}`;
    return c.json({
      stable: routes.find((route) => route.kind === "project") ? url(routes.find((route) => route.kind === "project")!.hostname) : null,
      previews: routes.filter((route) => route.kind === "deployment").map((route) => url(route.hostname)).sort(),
    });
  });

  app.get("/projects/:projectId/deployments", async (c) => {
    const projectId = c.req.param("projectId");
    const [deployments, retention, routes] = await Promise.all([
      store.listDeployments(projectId), store.getDeploymentRetention(projectId), store.listProjectRoutes(projectId),
    ]);
    return c.json({ deployments, retention, routes });
  });

  app.get("/projects/:projectId/variant-metrics", async (c) => {
    const sessions = await store.listSessions(c.req.param("projectId"));
    const groups = new Map<string, {
      deploymentId: string | null;
      experimentId: string | null;
      variantName: string;
      sessions: number;
      success: number;
      failure: number;
      latencyMs: number;
      latencySamples: number;
      tokens: number;
      costUsd: number;
    }>();
    for (const session of sessions) {
      const variantName = session.variantName ?? "unassigned";
      const groupKey = JSON.stringify([session.deploymentId, session.experimentId, variantName]);
      const group = groups.get(groupKey) ?? {
        deploymentId: session.deploymentId,
        experimentId: session.experimentId,
        variantName,
        sessions: 0,
        success: 0,
        failure: 0,
        latencyMs: 0,
        latencySamples: 0,
        tokens: 0,
        costUsd: 0,
      };
      group.sessions += 1;
      if (session.status === "completed") group.success += 1;
      if (session.status === "failed") group.failure += 1;
      if (session.completedAt) {
        group.latencyMs += Math.max(0, Date.parse(session.completedAt) - Date.parse(session.startedAt));
        group.latencySamples += 1;
      }
      group.tokens += session.usage.inputTokens + session.usage.outputTokens + session.usage.cacheReadTokens + session.usage.cacheWriteTokens;
      group.costUsd += session.usage.costUsd ?? 0;
      groups.set(groupKey, group);
    }
    return c.json({ variants: [...groups.values()].map(({ latencyMs, latencySamples, ...group }) => ({
      ...group,
      averageLatencyMs: latencySamples ? latencyMs / latencySamples : 0,
    })) });
  });

  app.post("/projects/:projectId/deployments/:deploymentId/promote", async (c) => {
    const route = await store.promoteDeployment(c.req.param("projectId"), c.req.param("deploymentId"));
    await invalidateGateway(options, [route.hostname]);
    return c.json({ route });
  });

  app.post("/projects/:projectId/deployments/:deploymentId/drain", async (c) => {
    const deployment = await store.getDeployment(c.req.param("deploymentId"));
    if (!deployment || deployment.projectId !== c.req.param("projectId")) return c.json({ error: "Deployment not found" }, 404);
    const routes = await store.listProjectRoutes(deployment.projectId);
    if (routes.some((route) => route.kind !== "deployment" && route.targets.some((target) => target.deploymentId === deployment.id && target.weight > 0))) {
      return c.json({ error: "Set this deployment route weight to zero before draining." }, 409);
    }
    const updated = await store.updateDeploymentStatus(deployment.id, "draining");
    return c.json({ deployment: updated });
  });

  app.post("/projects/:projectId/deployments/:deploymentId/archive", async (c) => {
    const projectId = c.req.param("projectId");
    const deploymentId = c.req.param("deploymentId");
    const policy = (await store.getDeploymentRetention(projectId)).find((entry) => entry.deployment.id === deploymentId);
    if (!policy) return c.json({ error: "Deployment not found" }, 404);
    if (policy.protected) return c.json({ error: "Deployment is protected from archive", reasons: policy.reasons }, 409);
    const job = await store.enqueueJob(projectId, "archive_deployment", { deploymentId });
    return c.json({ job }, 202);
  });

  app.put("/projects/:projectId/routes/:routeId/targets", async (c) => {
    const input = routeTargetsSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Invalid route targets", detail: input.error.flatten() }, 400);
    const routes = await store.listProjectRoutes(c.req.param("projectId"));
    const existing = routes.find((route) => route.id === c.req.param("routeId"));
    if (!existing) return c.json({ error: "Route not found" }, 404);
    if (existing.kind === "deployment") return c.json({ error: "Deployment preview routes are immutable" }, 409);
    const route = await store.updateRouteTargets(c.req.param("routeId"), input.data.targets);
    await invalidateGateway(options, [route.hostname]);
    return c.json({ route });
  });

  app.post("/projects/:projectId/aliases", async (c) => {
    const input = aliasSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Invalid alias route", detail: input.error.flatten() }, 400);
    const baseDomain = (process.env.EVELAND_AGENT_BASE_DOMAINS ?? "agent.localhost").split(",")[0]!.trim();
    const route = await store.ensureAliasRoute(c.req.param("projectId"), input.data.alias, baseDomain, input.data.targets);
    await invalidateGateway(options, [route.hostname]);
    return c.json({ route }, 201);
  });

  app.delete("/projects/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const job = await store.enqueueJob(projectId, "delete_project");
    return c.json({ job }, 202);
  });

  app.post("/projects/:projectId/build-deploy", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const job = await store.enqueueJob(projectId, "build_deploy");
    return c.json({ job }, 202);
  });

  app.post("/projects/:projectId/sync-source", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    if (project.importKind !== "git" || !project.gitUrl) {
      return c.json({ error: "Only git projects can sync source from a repository." }, 400);
    }

    const deploy = await readSyncDeployFlag(c);
    const job = await store.enqueueJob(projectId, "import_source", {
      importKind: "git",
      gitUrl: project.gitUrl,
      deployAfterImport: deploy,
    });
    return c.json({ job }, 202);
  });

  app.post("/projects/:projectId/restart", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const job = await store.enqueueJob(projectId, "restart_deployment");
    return c.json({ job }, 202);
  });

  app.post("/projects/:projectId/playground", async (c) => {
    const projectId = c.req.param("projectId");
    const parsed = playgroundMessageSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid playground message", issues: parsed.error.issues }, 400);
    }

    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const deployment = await store.getCurrentDeployment(projectId);
    if (!deployment || deployment.status !== "running") {
      return c.json({ error: "No running deployment" }, 409);
    }

    const session = await store.createSession({
      projectId,
      deploymentId: deployment.id,
      trigger: "playground",
      scheduleId: null,
    });
    await store.appendSessionEvent(session.id, "message", { role: "user", content: parsed.data.message });

    try {
      let eventPersistence = Promise.resolve();
      const persistEvent = (event: PlaygroundRunEvent) => {
        const queued = eventPersistence.then(async () => {
          await store.appendSessionEvent(session.id, event.type, event.payload);
        });
        eventPersistence = queued.catch(() => undefined);
        return queued;
      };
      const result = await playgroundRunner({ project, deployment, message: parsed.data.message, onEvent: persistEvent });
      for (const event of result.events ?? [{ type: "model_response", payload: { content: result.response } }]) {
        await persistEvent(event);
      }
      const completed = await store.completeSession(session.id, {
        status: result.status ?? "waiting",
        eveSessionId: result.eveSessionId ?? null,
        continuationToken: result.continuationToken ?? null,
      });
      return c.json({ session: completed, events: await store.listSessionEvents(session.id) }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.appendSessionEvent(session.id, "error", { message });
      const failed = await store.completeSession(session.id, { status: "failed" });
      return c.json({ error: "Playground request failed", detail: message, session: failed, events: await store.listSessionEvents(session.id) }, 502);
    }
  });

  app.get("/projects/:projectId/secrets", async (c) => {
    return c.json({ secrets: await store.listSecrets(c.req.param("projectId")) });
  });

  app.post("/projects/:projectId/secrets", async (c) => {
    const parsed = secretSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid secret input", issues: parsed.error.issues }, 400);
    }
    const encrypted = encryptSecretValue(parsed.data.value, process.env.APP_SECRET_KEY ?? devSecretKey);
    const secret = await store.upsertSecret(c.req.param("projectId"), parsed.data.key, JSON.stringify(encrypted));
    return c.json({ secret }, 201);
  });

  app.delete("/projects/:projectId/secrets/:secretId", async (c) => {
    const deleted = await store.deleteSecret(c.req.param("projectId"), c.req.param("secretId"));
    return c.json({ deleted });
  });

  app.get("/projects/:projectId/schedules", async (c) => {
    return c.json({ schedules: await store.listSchedules(c.req.param("projectId")) });
  });

  app.get("/projects/:projectId/source/revision", async (c) => {
    return c.json({ revision: await store.getCurrentSourceRevision(c.req.param("projectId")) });
  });

  app.get("/projects/:projectId/source/files", async (c) => {
    return c.json({ files: await store.listSourceFiles(c.req.param("projectId")) });
  });

  app.get("/projects/:projectId/source/file", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) {
      return c.json({ error: "Missing source file path" }, 400);
    }

    return c.json({ file: await store.getSourceFile(c.req.param("projectId"), filePath) });
  });

  app.get("/projects/:projectId/sessions", async (c) => {
    return c.json({ sessions: await store.listSessions(c.req.param("projectId")) });
  });

  app.get("/sessions/:sessionId/events", async (c) => {
    return c.json({ events: await store.listSessionEvents(c.req.param("sessionId")) });
  });

  app.get("/sessions/:sessionId/usage", async (c) => {
    return c.json({ usage: await store.listModelUsageEvents(c.req.param("sessionId")) });
  });

  app.get("/sessions/:sessionId/nodes", async (c) => {
    return c.json({ nodes: await store.listSessionNodes(c.req.param("sessionId")) });
  });

  app.get("/projects/:projectId/logs", async (c) => {
    const type = c.req.query("type") as LogRecord["type"] | undefined;
    return c.json({ logs: await store.listLogs(c.req.param("projectId"), type) });
  });

  return app;
}

async function invalidateGateway(options: AppOptions, hostnames: string[]): Promise<void> {
  if (options.invalidateGatewayRoutes) return options.invalidateGatewayRoutes(hostnames);
  const gatewayUrl = process.env.EVELAND_GATEWAY_INTERNAL_URL;
  const token = process.env.EVELAND_GATEWAY_SERVICE_TOKEN;
  if (!gatewayUrl || !token) return;
  for (const hostname of hostnames) {
    const response = await fetch(`${gatewayUrl.replace(/\/$/, "")}/internal/cache/invalidate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ hostname }),
    });
    if (!response.ok) throw new Error(`Gateway cache invalidation failed with ${response.status}.`);
  }
}

function isMultipartRequest(c: Context): boolean {
  return (c.req.header("content-type") ?? "").toLowerCase().includes("multipart/form-data");
}

// The sync body is optional; only `{ "deploy": true }` opts into an automatic
// deploy of the freshly synced source, otherwise the sync just refreshes it.
async function readSyncDeployFlag(c: Context): Promise<boolean> {
  try {
    const body = (await c.req.json()) as unknown;
    return typeof body === "object" && body !== null && (body as { deploy?: unknown }).deploy === true;
  } catch {
    return false;
  }
}

async function createZipProjectFromUpload(c: Context, store: Store, dataDir: string) {
  const form = await c.req.formData();
  const name = form.get("name");
  const archive = form.get("archive");

  if (typeof name !== "string" || name.trim().length === 0) {
    return c.json({ error: "Invalid project input", issues: [{ path: ["name"], message: "Project name is required" }] }, 400);
  }

  if (!(archive instanceof File) || archive.size === 0) {
    return c.json({ error: "Invalid zip upload", issues: [{ path: ["archive"], message: "Source archive is required" }] }, 400);
  }

  const sourcePath = await extractZipUpload(archive, dataDir);
  const project = await store.createProject({
    name: name.trim(),
    importKind: "zip",
    sourcePath,
  });
  return c.json({ project }, 201);
}

async function extractZipUpload(archive: File, dataDir: string): Promise<string> {
  const uploadsDir = path.resolve(dataDir, "uploads");
  await mkdir(uploadsDir, { recursive: true });
  const uploadDir = await mkdtemp(path.join(uploadsDir, "zip-"));
  const archivePath = path.join(uploadDir, "source.zip");
  const extractDir = path.join(uploadDir, "source");
  await mkdir(extractDir, { recursive: true });
  await writeFile(archivePath, Buffer.from(await archive.arrayBuffer()));

  const entries = await listZipEntries(archivePath);
  for (const entry of entries) {
    assertSafeZipEntry(entry);
  }

  await execFileAsync("unzip", ["-q", archivePath, "-d", extractDir]);
  return resolveExtractedSourceRoot(extractDir);
}

async function listZipEntries(archivePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("unzip", ["-Z1", archivePath]);
  return stdout.split(/\r?\n/).filter(Boolean);
}

function assertSafeZipEntry(entry: string): void {
  const normalizedEntry = entry.trim().replace(/\/+$/, "");
  if (normalizedEntry.length === 0) {
    return;
  }

  assertSafeArchivePath(normalizedEntry);
}

async function resolveExtractedSourceRoot(extractDir: string): Promise<string> {
  const entries = await readdir(extractDir, { withFileTypes: true });
  const projectEntries = entries.filter((entry) => entry.name !== "__MACOSX" && entry.name !== ".DS_Store");

  if (projectEntries.length === 1 && projectEntries[0]?.isDirectory()) {
    return path.join(extractDir, projectEntries[0].name);
  }

  return extractDir;
}
