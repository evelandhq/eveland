import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import type { DeploymentRecord, LogRecord, Project } from "@eveland/core/contracts";
import {
  extractEveResponseText as extractResponseText,
  getEveString as getString,
  isEveRecord as isRecord,
  parseEveJsonObject as parseJsonObject,
} from "@eveland/core/eve";
import { assertSafeArchivePath } from "@eveland/core/server/archive";
import { encryptSecretValue } from "@eveland/core/server/secrets";
import type { Store } from "@eveland/db";
import type { CollectorHealth } from "@eveland/session-collector/health";
import { z } from "zod";

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

const devSecretKey = "eveland-dev-secret-key-000000000";

export type PlaygroundRunEvent = {
  type: string;
  payload: unknown;
  source?: {
    eveSessionId: string;
    agentId: string | null;
    agentName: string | null;
  };
};

export type PlaygroundRunResult = {
  response: string;
  eveSessionId?: string | null;
  continuationToken?: string | null;
  events?: PlaygroundRunEvent[];
};

export type PlaygroundRunnerInput = {
  project: Project;
  deployment: DeploymentRecord;
  message: string;
  onEvent?: (event: PlaygroundRunEvent) => Promise<void>;
};

export type PlaygroundRunner = (input: PlaygroundRunnerInput) => Promise<PlaygroundRunResult>;

export type AppOptions = {
  playgroundRunner?: PlaygroundRunner;
  dataDir?: string;
  collectorHealth?: () => CollectorHealth;
};

export function createApp(store: Store, options: AppOptions = {}): Hono {
  const app = new Hono();
  const playgroundRunner = options.playgroundRunner ?? runDeploymentPlayground;
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
        status: "completed",
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

// An eve deployment exposes a stable HTTP API: POST /eve/v1/session starts a run
// (returning 202 with a session id) and the assistant reply arrives over the NDJSON
// stream at GET /eve/v1/session/:id/stream. We start the run, then read the stream
// to completion to surface the final message in the playground.
async function runDeploymentPlayground(input: PlaygroundRunnerInput): Promise<PlaygroundRunResult> {
  const base = `http://127.0.0.1:${input.deployment.hostPort}`;

  const startResponse = await fetch(`${base}/eve/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: input.message }),
  });
  const startText = await startResponse.text();

  if (!startResponse.ok) {
    throw new Error(`Deployment returned ${startResponse.status}: ${startText}`);
  }

  const startBody = parseJsonObject(startText);
  const sessionId =
    startResponse.headers.get("x-eve-session-id") ?? getString(startBody, "sessionId") ?? getString(startBody, "session_id");
  const continuationToken = getString(startBody, "continuationToken") ?? getString(startBody, "continuation_token");

  if (!sessionId) {
    const content = extractResponseText(startBody, startText);
    const event = { type: "model_response", payload: { content } } satisfies PlaygroundRunEvent;
    await input.onEvent?.(event);
    return {
      response: content,
      eveSessionId: null,
      continuationToken,
      events: input.onEvent ? [] : [event],
    };
  }

  const streamed = await streamEveSession(base, sessionId, input.onEvent);
  const modelResponse = { type: "model_response", payload: { content: streamed.response } } satisfies PlaygroundRunEvent;
  await input.onEvent?.(modelResponse);

  return {
    response: streamed.response,
    eveSessionId: sessionId,
    continuationToken,
    events: input.onEvent ? [] : [...streamed.events, modelResponse],
  };
}

// A conversational eve agent parks on `session.waiting` (or ends the turn) after replying
// rather than `session.completed`, so treat the turn boundary as terminal for the playground.
const terminalEventTypes = new Set([
  "turn.completed",
  "session.waiting",
  "session.completed",
  "session.failed",
  "session.errored",
  "turn.failed",
]);
// Streaming deltas are noisy for the session timeline; we keep lifecycle events only.
const deltaEventTypes = new Set(["message.appended", "reasoning.appended"]);

async function streamEveSession(
  base: string,
  sessionId: string,
  onEvent?: (event: PlaygroundRunEvent) => Promise<void>,
): Promise<{ response: string; events: PlaygroundRunEvent[] }> {
  const timeoutMs = Number(process.env.EVELAND_PLAYGROUND_TIMEOUT_MS ?? 120_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const events: PlaygroundRunEvent[] = [];
  let completedMessage: string | null = null;
  let latestPartial = "";
  let failureMessage: string | null = null;
  let agentId: string | null = null;
  let agentName: string | null = null;

  try {
    const response = await fetch(`${base}/eve/v1/session/${encodeURIComponent(sessionId)}/stream`, {
      headers: { accept: "application/x-ndjson" },
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Session stream returned ${response.status}.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;

    try {
      while (!done) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) {
            continue;
          }

          const event = parseJsonObject(line);
          if (!event) {
            continue;
          }

          const type = typeof event.type === "string" ? event.type : "event";
          const data = (isRecord(event.data) ? event.data : event) as Record<string, unknown>;

          if (type === "session.started" && isRecord(data.runtime)) {
            agentId = getString(data.runtime, "agentId");
            agentName = getString(data.runtime, "agentName");
          }

          if (type === "message.appended") {
            latestPartial = getString(data, "messageSoFar") ?? latestPartial;
          } else if (type === "message.completed") {
            completedMessage =
              getString(data, "message") ??
              getString(data, "text") ??
              getString(data, "content") ??
              getString(data, "messageSoFar") ??
              completedMessage;
          } else if (type === "turn.failed" || type === "session.failed" || type === "session.errored") {
            failureMessage = getString(data, "message") ?? getString(data, "error") ?? failureMessage;
          }

          if (!deltaEventTypes.has(type)) {
            const streamedEvent = {
              type,
              payload: data,
              source: { eveSessionId: sessionId, agentId, agentName },
            } satisfies PlaygroundRunEvent;
            events.push(streamedEvent);
            await onEvent?.(streamedEvent);
          }

          if (terminalEventTypes.has(type)) {
            done = true;
            break;
          }
        }
      }
    } catch (error) {
      // A timeout abort is expected when a run is slow; surface partial output instead of failing.
      if (!(error instanceof Error && error.name === "AbortError")) {
        throw error;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
  }

  const response = completedMessage ?? latestPartial;

  if (!response) {
    throw new Error(failureMessage ? `Eve session failed: ${failureMessage}` : "Eve session produced no response.");
  }

  return { response, events };
}
