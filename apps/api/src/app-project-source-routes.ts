import { rm } from "node:fs/promises";
import {
  inferProjectSlugFromGitUrl,
  normalizeGitHttpHost,
} from "@eveland/core/ids";
import { toPublicJob } from "@eveland/core/jobs";
import { encryptSecretValue } from "@eveland/core/server/secrets";
import {
  DEFAULT_API_SESSION_IDLE_TTL_MS,
  DEFAULT_PLAYGROUND_SESSION_IDLE_TTL_MS,
} from "@eveland/core/routing";
import {
  DeploymentNotFoundError,
  DeploymentNotPromotableError,
  ProjectRouteNotFoundError,
  ProjectSlugConflictError,
  type Store,
} from "@eveland/db";
import type { MiddlewareHandler } from "hono";
import { publicDeployment } from "./app-public-projections.js";
import type { ApiApp, AppOptions } from "./app-types.js";
import {
  aliasSchema,
  buildDeploySchema,
  createGitSourcePreflightSchema,
  createProjectFromPreflightSchema,
  createProjectSchema,
  projectNameSchema,
  routeTargetsSchema,
  syncSourceSchema,
  updateProjectMetadataSchema,
} from "./app-schemas.js";
import { bodyLimit } from "hono/body-limit";
import {
  createZipProjectFromUpload,
  currentUserId,
  extractZipUpload,
  InvalidZipUploadError,
  invalidateGateway,
  invalidateGatewayAfterCommit,
  isMultipartRequest,
  publicGatewayUrl,
  resolveProjectEveVersion,
} from "./app-support.js";

type CreateGitCredentialInput = {
  userId: string;
  host: string;
  encryptedToken: string;
  persistAfterImport: boolean;
};

export function registerProjectSourceRoutes(input: {
  app: ApiApp;
  store: Store;
  dataDir: string;
  appSecretKey: string;
  sourcePreflightTtlMs: number;
}): void {
  const { app, store, dataDir, appSecretKey, sourcePreflightTtlMs } = input;
  app.get("/projects/name-availability", async (c) => {
    const parsed = projectNameSchema.safeParse(c.req.query("name"));
    if (!parsed.success) {
      return c.json(
        { error: "Invalid project name", issues: parsed.error.issues },
        400,
      );
    }
    return c.json({
      available: await store.isProjectSlugAvailable(parsed.data),
    });
  });

  app.get("/git-credentials", async (c) => {
    return c.json({
      credentials: await store.listGitCredentials(currentUserId(c)),
    });
  });

  app.delete("/git-credentials/:credentialId", async (c) => {
    const deleted = await store.deleteGitCredential(
      currentUserId(c),
      c.req.param("credentialId"),
    );
    return deleted
      ? c.body(null, 204)
      : c.json({ error: "Git credential not found" }, 404);
  });

  // Uploads were previously unbounded: c.req.formData() buffers the archive
  // in memory, so a single request could exhaust the API process. Playground
  // and OTLP bodies already have caps; this closes the last unbounded route.
  const uploadBodyLimit = bodyLimit({
    maxSize: Number(process.env.EVELAND_MAX_UPLOAD_BYTES ?? 104_857_600),
    onError: (c) => c.json({ error: "Upload too large" }, 413),
  });

  app.post("/source-preflights", uploadBodyLimit, async (c) => {
    const expiresAt = new Date(Date.now() + sourcePreflightTtlMs);
    if (isMultipartRequest(c)) {
      const form = await c.req.formData();
      const archive = form.get("archive");
      if (!(archive instanceof File) || archive.size === 0) {
        return c.json(
          {
            error: "Invalid zip upload",
            issues: [
              { path: ["archive"], message: "Source archive is required" },
            ],
          },
          400,
        );
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
        const preflight = await store.createSourcePreflight({
          userId: currentUserId(c),
          kind: "zip",
          sourcePath,
          expiresAt,
        });
        return c.json({ preflight }, 202);
      } catch (error) {
        await rm(uploadDir, { recursive: true, force: true });
        throw error;
      }
    }

    const parsed = createGitSourcePreflightSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        {
          error: "Invalid source preflight input",
          issues: parsed.error.issues,
        },
        400,
      );
    const userId = currentUserId(c);
    const host = normalizeGitHttpHost(parsed.data.gitUrl);
    if (parsed.data.gitlabPat && !host) {
      return c.json(
        {
          error:
            "GitLab PAT authentication requires an HTTPS repository URL without embedded credentials.",
        },
        400,
      );
    }
    const stored =
      host && !parsed.data.gitlabPat
        ? await store.getGitCredential(userId, host)
        : null;
    const gitCredential: CreateGitCredentialInput | undefined =
      parsed.data.gitlabPat && host
        ? {
            userId,
            host,
            encryptedToken: JSON.stringify(
              encryptSecretValue(parsed.data.gitlabPat, appSecretKey),
            ),
            persistAfterImport: true,
          }
        : stored
          ? {
              userId,
              host: stored.host,
              encryptedToken: stored.encryptedToken,
              persistAfterImport: false,
            }
          : undefined;
    const preflight = await store.createSourcePreflight({
      userId,
      kind: "git",
      gitUrl: parsed.data.gitUrl,
      expiresAt,
      ...(gitCredential ? { gitCredential } : {}),
    });
    return c.json({ preflight }, 202);
  });

  app.get("/source-preflights/:preflightId", async (c) => {
    const preflight = await store.getSourcePreflight(
      c.req.param("preflightId"),
      currentUserId(c),
    );
    return preflight
      ? c.json({ preflight })
      : c.json({ error: "Source preflight not found" }, 404);
  });

  app.post("/projects", uploadBodyLimit, async (c) => {
    if (isMultipartRequest(c)) {
      return createZipProjectFromUpload(c, store, dataDir);
    }

    const input = await c.req.json().catch(() => null);
    if (typeof input === "object" && input !== null && "preflightId" in input) {
      const parsedPreflight = createProjectFromPreflightSchema.safeParse(input);
      if (!parsedPreflight.success) {
        return c.json(
          {
            error: "Invalid project input",
            issues: parsedPreflight.error.issues,
          },
          400,
        );
      }
      try {
        const { environmentVariables, ...projectInput } = parsedPreflight.data;
        const result = await store.createProjectFromSourcePreflight({
          ...projectInput,
          userId: currentUserId(c),
          secrets: environmentVariables.map((variable) => ({
            key: variable.key,
            kind: variable.kind,
            encryptedValue: JSON.stringify(
              encryptSecretValue(variable.value, appSecretKey),
            ),
          })),
        });
        if (result.outcome === "not_found")
          return c.json({ error: "Source preflight not found" }, 404);
        if (result.outcome === "not_ready")
          return c.json({ error: "Source preflight is not ready" }, 409);
        if (result.outcome === "consumed")
          return c.json(
            { error: "Source preflight has already been used" },
            409,
          );
        return c.json({ project: result.project }, 201);
      } catch (error) {
        if (error instanceof ProjectSlugConflictError)
          return c.json({ error: error.message }, 409);
        throw error;
      }
    }

    const parsed = createProjectSchema.safeParse(input);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid project input", issues: parsed.error.issues },
        400,
      );
    }

    const name =
      parsed.data.importKind === "git"
        ? (parsed.data.name ?? inferProjectSlugFromGitUrl(parsed.data.gitUrl))
        : parsed.data.name;
    if (!name) {
      return c.json({ error: "Invalid project input" }, 400);
    }
    let gitCredential: CreateGitCredentialInput | undefined;
    if (parsed.data.importKind === "git") {
      const host = normalizeGitHttpHost(parsed.data.gitUrl);
      if (parsed.data.gitlabPat && !host) {
        return c.json(
          {
            error:
              "GitLab PAT authentication requires an HTTPS repository URL without embedded credentials.",
          },
          400,
        );
      }
      if (host) {
        const userId = currentUserId(c);
        const stored = parsed.data.gitlabPat
          ? null
          : await store.getGitCredential(userId, host);
        if (parsed.data.gitlabPat) {
          gitCredential = {
            userId,
            host,
            encryptedToken: JSON.stringify(
              encryptSecretValue(parsed.data.gitlabPat, appSecretKey),
            ),
            persistAfterImport: true,
          };
        } else if (stored) {
          gitCredential = {
            userId,
            host,
            encryptedToken: stored.encryptedToken,
            persistAfterImport: false,
          };
        }
      }
    }
    try {
      const project =
        parsed.data.importKind === "git"
          ? await store.createProject({
              name,
              importKind: "git",
              gitUrl: parsed.data.gitUrl,
              requireExactSlug: true,
              deployAfterImport: parsed.data.deployAfterImport,
              ...(gitCredential ? { gitCredential } : {}),
            })
          : await store.createProject({
              ...parsed.data,
              name,
              requireExactSlug: true,
            });
      return c.json({ project }, 201);
    } catch (error) {
      if (error instanceof ProjectSlugConflictError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

}
