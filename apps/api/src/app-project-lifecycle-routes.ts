import { bodyLimit } from "hono/body-limit";
import { normalizeGitHttpHost } from "@evelandhq/core/ids";
import { toPublicJob } from "@evelandhq/core/jobs";
import { type Store } from "@evelandhq/db";
import type { ApiApp } from "./app-types.js";
import { buildDeploySchema, syncSourceSchema } from "./app-schemas.js";
import {
  currentUserId,
  extractZipUpload,
  InvalidZipUploadError,
  isMultipartRequest,
} from "./app-support.js";

// The narrow persistence port this slice actually needs.
export type ProjectLifecycleStore = Pick<
  Store,
  "enqueueJob" | "getGitCredential" | "getProject" | "listProjectJobs" | "requestProjectDeletion"
>;

export function registerProjectLifecycleRoutes(input: {
  app: ApiApp;
  store: ProjectLifecycleStore;
  dataDir: string;
}): void {
  const { app, store, dataDir } = input;
  // Same cap as the create/preflight uploads: formData() buffers in memory.
  const uploadBodyLimit = bodyLimit({
    maxSize: Number(process.env.EVELAND_MAX_UPLOAD_BYTES ?? 104_857_600),
    onError: (c) => c.json({ error: "Upload too large" }, 413),
  });
  app.get("/api/projects/:projectId/jobs", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    const projectJobs =
      c.req.query("include") === "deployment"
        ? await store.listProjectJobs(projectId, { limit: 50 })
        : await store.listProjectJobs(projectId, { type: "import_source" });
    return c.json({
      jobs: projectJobs.map(toPublicJob),
    });
  });

  app.delete("/api/projects/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const request = await store.requestProjectDeletion(projectId);
    if (request.outcome === "not_found") return c.json({ error: "Project not found" }, 404);
    if (request.outcome === "already_deleting")
      return c.json({ error: "Project is being deleted" }, 409);
    return c.json({ job: toPublicJob(request.job) }, 202);
  });

  app.post("/api/projects/:projectId/build-deploy", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const deployOptions = buildDeploySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!deployOptions.success) {
      return c.json(
        {
          error: "Invalid deployment options",
          detail: deployOptions.error.flatten(),
        },
        400,
      );
    }
    const job = await store.enqueueJob(projectId, "build_deploy", {
      promoteAfterDeploy: deployOptions.data.promote,
    });
    return c.json({ job: toPublicJob(job) }, 202);
  });

  app.post("/api/projects/:projectId/sync-source", uploadBodyLimit, async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    // Multipart replaces a zip project's source with a fresh upload — the
    // `eveland deploy` loop. Git projects keep the JSON re-clone below.
    if (isMultipartRequest(c)) {
      if (project.importKind !== "zip") {
        return c.json({ error: "Only zip projects accept a source upload." }, 400);
      }
      const form = await c.req.formData();
      const archive = form.get("archive");
      if (!(archive instanceof File) || archive.size === 0) {
        return c.json(
          {
            error: "Invalid zip upload",
            issues: [{ path: ["archive"], message: "Source archive is required" }],
          },
          400,
        );
      }
      const deploy = form.get("deploy") === "true";
      const promote = form.get("promote") === "true";
      if (promote && !deploy) {
        return c.json(
          { error: "A synced source must be deployed before it can be promoted." },
          400,
        );
      }
      let extracted;
      try {
        extracted = await extractZipUpload(archive, dataDir);
      } catch (error) {
        if (error instanceof InvalidZipUploadError) {
          return c.json(
            {
              error: "Invalid zip upload",
              issues: [{ path: ["archive"], message: error.message }],
            },
            400,
          );
        }
        throw error;
      }
      const job = await store.enqueueJob(projectId, "import_source", {
        importKind: "zip",
        sourcePath: extracted.sourcePath,
        deployAfterImport: deploy,
        promoteAfterDeploy: promote,
      });
      return c.json({ job: toPublicJob(job) }, 202);
    }
    if (project.importKind !== "git" || !project.gitUrl) {
      return c.json({ error: "Only git projects can sync source from a repository." }, 400);
    }

    const syncOptions = syncSourceSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!syncOptions.success) {
      return c.json(
        {
          error: "Invalid source sync options",
          detail: syncOptions.error.flatten(),
        },
        400,
      );
    }
    const host = normalizeGitHttpHost(project.gitUrl);
    const storedCredential = host ? await store.getGitCredential(currentUserId(c), host) : null;
    const job = await store.enqueueJob(projectId, "import_source", {
      importKind: "git",
      gitUrl: project.gitUrl,
      deployAfterImport: syncOptions.data.deploy,
      promoteAfterDeploy: syncOptions.data.promote,
      ...(storedCredential
        ? {
            gitCredential: {
              userId: storedCredential.userId,
              host: storedCredential.host,
              encryptedToken: storedCredential.encryptedToken,
              persistAfterImport: false,
            },
          }
        : {}),
    });
    return c.json({ job: toPublicJob(job) }, 202);
  });

  app.post("/api/projects/:projectId/restart", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const job = await store.enqueueJob(projectId, "restart_deployment");
    return c.json({ job: toPublicJob(job) }, 202);
  });
}
