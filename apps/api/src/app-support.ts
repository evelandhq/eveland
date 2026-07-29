import { type AgentAuthFailure } from "@eveland/agent-auth";
import type {
  ActivationLeaseClaim,
  AuthPrincipal,
  RuntimeInstance,
  SessionStatus,
  TeamInvitation,
} from "@eveland/core/contracts";
import { getEveString, parseEveJsonObject } from "@eveland/core/eve";
import { assertSafeArchivePath } from "@eveland/core/server/archive";
import {
  createEveVersionInfo,
  readDeclaredEveVersion,
  type EveVersionInfo,
} from "@eveland/core/source";
import { ProjectSlugConflictError, type Store } from "@eveland/db";
import type { Context } from "hono";
import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { projectNameSchema } from "./app-schemas.js";
import type { AppOptions } from "./app-types.js";

const execFileAsync = promisify(execFile);

export function publicInvitation(invitation: TeamInvitation) {
  return invitation;
}

export function publicGatewayUrl(
  hostname: string,
  options: AppOptions,
): string {
  const scheme =
    options.gatewayPublicScheme ??
    (process.env.EVELAND_GATEWAY_PUBLIC_SCHEME === "https" ? "https" : "http");
  const configuredPort =
    options.gatewayPublicPort ??
    Number(
      process.env.EVELAND_GATEWAY_PUBLIC_PORT ??
        (scheme === "http" ? 4080 : 0),
    );
  return `${scheme}://${hostname}${configuredPort ? `:${configuredPort}` : ""}`;
}

export function getSetCookies(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };
  return (
    withGetSetCookie.getSetCookie?.() ??
    (headers.get("set-cookie") ? [headers.get("set-cookie")!] : [])
  );
}

export function authErrorResponse(c: Context, error: unknown): Response {
  const message =
    error instanceof Error ? error.message : "Authentication request failed";
  if (message === "Admin access required")
    return c.json({ error: message }, 403);
  if (message === "Invalid email or password")
    return c.json({ error: message }, 401);
  if (
    message.includes("last admin") ||
    message.includes("already a team member") ||
    message.includes("no longer pending")
  ) {
    return c.json({ error: message }, 409);
  }
  if (message.includes("not found")) return c.json({ error: message }, 404);
  return c.json({ error: message }, 400);
}

export async function invalidateGateway(
  options: AppOptions,
  hostnames: string[],
): Promise<void> {
  if (options.invalidateGatewayRoutes)
    return options.invalidateGatewayRoutes(hostnames);
  const gatewayUrl = process.env.EVELAND_GATEWAY_INTERNAL_URL;
  const token = process.env.EVELAND_GATEWAY_SERVICE_TOKEN;
  if (!gatewayUrl || !token) return;
  for (const hostname of hostnames) {
    const response = await fetch(
      `${gatewayUrl.replace(/\/$/, "")}/internal/cache/invalidate`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ hostname }),
      },
    );
    if (!response.ok)
      throw new Error(
        `Gateway cache invalidation failed with ${response.status}.`,
      );
  }
}

export function playgroundSessionIdFromPath(pathname: string): string | null {
  if (pathname === "/eve/v1/session/reset") return null;
  const match = /^\/eve\/v1\/session\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export async function readLimitedPlaygroundBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes)
    throw new Error("Playground request body is too large.");
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader
          .cancel("Playground request body is too large.")
          .catch(() => undefined);
        throw new Error("Playground request body is too large.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function parsePlaygroundBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new Error("Playground turn must be valid JSON.");
  }
}

export async function parsePlaygroundResponse(
  response: Response,
): Promise<Record<string, unknown> | null> {
  if (!response.headers.get("content-type")?.includes("application/json"))
    return null;
  return parseEveJsonObject(await response.text());
}

export async function resolveProjectEveVersion(
  store: Store,
  projectId: string,
  deploymentId?: string,
): Promise<EveVersionInfo> {
  const deployment = deploymentId
    ? await store.getDeployment(deploymentId)
    : await store.getCurrentDeployment(projectId);
  if (deployment) {
    return (
      (await store.getDeploymentEveVersion(deployment.id)) ??
      createEveVersionInfo(null, null)
    );
  }

  const revision = await store.getCurrentSourceRevision(projectId);
  let version = revision ? getEveString(revision.summary, "eveVersion") : null;

  if (!version && revision) {
    const packageJson = await store.getSourceFile(projectId, "package.json");
    if (packageJson)
      version = readDeclaredEveVersion([
        { path: packageJson.path, content: packageJson.content },
      ]);
  }

  return createEveVersionInfo(version, revision?.id ?? null);
}

export function monitorPlaygroundStream(
  body: ReadableStream<Uint8Array>,
  store: Store,
  platformSessionId: string,
  eveSessionId: string,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentStatus: SessionStatus = "running";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          const tail = buffer.trim();
          if (tail)
            currentStatus = await projectPlaygroundStreamLine(
              tail,
              currentStatus,
              store,
              platformSessionId,
              eveSessionId,
            );
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line)
            currentStatus = await projectPlaygroundStreamLine(
              line,
              currentStatus,
              store,
              platformSessionId,
              eveSessionId,
            );
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

export async function projectPlaygroundStreamLine(
  line: string,
  currentStatus: SessionStatus,
  store: Store,
  platformSessionId: string,
  eveSessionId: string,
): Promise<SessionStatus> {
  const event = parseEveJsonObject(line);
  const type = getEveString(event, "type");
  let nextStatus: SessionStatus | null = null;
  if (type === "session.started" || type === "turn.started")
    nextStatus = "running";
  else if (type === "input.requested") nextStatus = "waiting_approval";
  else if (type === "session.waiting")
    nextStatus =
      currentStatus === "waiting_approval" ? "waiting_approval" : "waiting";
  else if (type === "session.completed") nextStatus = "completed";
  else if (type === "session.failed") nextStatus = "failed";
  if (!nextStatus) return currentStatus;
  await store
    .completeSession(platformSessionId, { status: nextStatus, eveSessionId })
    .catch(() => null);
  return nextStatus;
}

export function isMultipartRequest(c: Context): boolean {
  return (c.req.header("content-type") ?? "")
    .toLowerCase()
    .includes("multipart/form-data");
}

export function currentUserId(
  c: Context<{ Variables: { principal: AuthPrincipal } }>,
): string {
  return c.get("principal")?.userId ?? "user_local_admin";
}

export function agentAuthFailureStatus(
  failure: AgentAuthFailure,
): 401 | 409 | 422 | 503 {
  if (
    failure.code === "interaction_required" ||
    failure.code === "credential_rejected"
  )
    return 401;
  if (failure.code === "retry_required") return 409;
  if (failure.code === "configuration_invalid") return 422;
  return 503;
}

export async function createZipProjectFromUpload(
  c: Context,
  store: Store,
  dataDir: string,
) {
  const form = await c.req.formData();
  const name = form.get("name");
  const archive = form.get("archive");
  const deployAfterImport = form.get("deployAfterImport") === "true";

  const parsedName = projectNameSchema.safeParse(name);
  if (!parsedName.success) {
    return c.json(
      {
        error: "Invalid project input",
        issues: parsedName.error.issues.map((issue) => ({
          ...issue,
          path: ["name", ...issue.path],
        })),
      },
      400,
    );
  }

  if (!(archive instanceof File) || archive.size === 0) {
    return c.json(
      {
        error: "Invalid zip upload",
        issues: [{ path: ["archive"], message: "Source archive is required" }],
      },
      400,
    );
  }

  if (!(await store.isProjectSlugAvailable(parsedName.data))) {
    return c.json({ error: "Project name is already in use." }, 409);
  }

  let extracted;
  try {
    extracted = await extractZipUpload(archive, dataDir);
  } catch (error) {
    if (error instanceof InvalidZipUploadError) {
      return c.json(
        { error: "Invalid zip upload", issues: [{ path: ["archive"], message: error.message }] },
        400,
      );
    }
    throw error;
  }
  const { sourcePath, uploadDir } = extracted;
  try {
    const project = await store.createProject({
      name: parsedName.data,
      importKind: "zip",
      sourcePath,
      requireExactSlug: true,
      deployAfterImport,
    });
    return c.json({ project }, 201);
  } catch (error) {
    await rm(uploadDir, { recursive: true, force: true });
    if (error instanceof ProjectSlugConflictError) {
      return c.json({ error: error.message }, 409);
    }
    throw error;
  }
}

/** A rejected upload: hostile or malformed archive content, reported as 400. */
export class InvalidZipUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidZipUploadError";
  }
}

export async function extractZipUpload(
  archive: File,
  dataDir: string,
): Promise<{ sourcePath: string; uploadDir: string }> {
  const uploadsDir = path.resolve(dataDir, "uploads");
  await mkdir(uploadsDir, { recursive: true });
  const uploadDir = await mkdtemp(path.join(uploadsDir, "zip-"));
  try {
    const archivePath = path.join(uploadDir, "source.zip");
    const extractDir = path.join(uploadDir, "source");
    await mkdir(extractDir, { recursive: true });
    await writeFile(archivePath, Buffer.from(await archive.arrayBuffer()));

    const entries = await listZipEntries(archivePath);
    for (const entry of entries) {
      try {
        assertSafeZipEntry(entry);
      } catch (error) {
        throw new InvalidZipUploadError(error instanceof Error ? error.message : String(error));
      }
    }
    await assertNoSymlinkZipEntries(archivePath);

    await execFileAsync("unzip", ["-q", archivePath, "-d", extractDir]);
    await rm(archivePath, { force: true });
    // Defense in depth behind the listing check: whatever Info-ZIP actually
    // materialized, a symlink inside the extracted tree can redirect every
    // later read/write (imports, builds) outside the upload directory.
    await assertNoSymlinksOnDisk(extractDir);
    return {
      sourcePath: await resolveExtractedSourceRoot(extractDir),
      uploadDir,
    };
  } catch (error) {
    await rm(uploadDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Rejects archives containing symlink entries before extraction. Entry-name
 * validation alone cannot catch them: `link -> /outside` followed by
 * `link/file` has only "safe" names, yet Info-ZIP recreates the symlink and
 * then writes the second entry through it, outside the extraction dir.
 */
export async function assertNoSymlinkZipEntries(archivePath: string): Promise<void> {
  const { stdout } = await execFileAsync("unzip", ["-Z", archivePath]);
  // `unzip -Z` entry lines begin with a unix mode string; symlinks are `l...`.
  if (stdout.split(/\r?\n/).some((line) => /^l[rwxst-]{9}/.test(line))) {
    throw new InvalidZipUploadError("Zip archives must not contain symbolic links.");
  }
}

async function assertNoSymlinksOnDisk(extractDir: string): Promise<void> {
  const entries = await readdir(extractDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new InvalidZipUploadError("Zip archives must not contain symbolic links.");
    }
  }
}

export async function listZipEntries(archivePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("unzip", ["-Z1", archivePath]);
  return stdout.split(/\r?\n/).filter(Boolean);
}

export function assertSafeZipEntry(entry: string): void {
  const normalizedEntry = entry.trim().replace(/\/+$/, "");
  if (normalizedEntry.length === 0) {
    return;
  }

  assertSafeArchivePath(normalizedEntry);
}

export async function resolveExtractedSourceRoot(
  extractDir: string,
): Promise<string> {
  const entries = await readdir(extractDir, { withFileTypes: true });
  const projectEntries = entries.filter(
    (entry) => entry.name !== "__MACOSX" && entry.name !== ".DS_Store",
  );

  if (projectEntries.length === 1 && projectEntries[0]?.isDirectory()) {
    return path.join(extractDir, projectEntries[0].name);
  }

  return extractDir;
}

export function safeSecretEqual(expected: string, actual: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const actualDigest = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

export function isServiceRequest(
  authorization: string | undefined,
  token: string | undefined,
): boolean {
  return Boolean(
    token && authorization && safeSecretEqual(`Bearer ${token}`, authorization),
  );
}

export function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive integer.`);
  return value;
}

export async function waitForRuntimeActivation(
  store: Store,
  claim: ActivationLeaseClaim,
  input: { signal: AbortSignal; timeoutMs: number },
): Promise<RuntimeInstance> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (input.signal.aborted) throw new Error("Runtime activation aborted.");
    const current = await store.getRuntimeInstance(claim.runtimeInstance.id);
    if (!current)
      throw new Error("RuntimeInstance disappeared during activation.");
    if (current.status === "ready") return current;
    if (current.status === "failed" || current.status === "stopped") {
      throw new Error(
        current.lastError ?? `Runtime activation ended in ${current.status}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Runtime activation timed out after ${input.timeoutMs}ms.`);
}
