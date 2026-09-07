import { bodyLimit } from "hono/body-limit";
import { normalizeGitHttpHost } from "@evelandhq/core/ids";
import { toPublicJob } from "@evelandhq/core/jobs";
import { deriveSourceDrift } from "@evelandhq/core/source-drift";
import { type Store } from "@evelandhq/db";
import type { ApiApp } from "./app-types.js";
import { buildDeploySchema, syncSourceSchema, uploadProvenanceSchema } from "./app-schemas.js";
import {
  currentUserId,
  extractZipUpload,
  InvalidZipUploadError,
  isMultipartRequest,
  sourceUploadOrigin,
} from "./app-support.js";

/**
 * Multipart fields arrive as strings; an absent or empty field is "not
 * reported", and only "true"/"false" are booleans -- anything else reaches
 * the schema as-is so it can be refused with a field-level issue.
 */
function readUploadProvenance(form: FormData): unknown {
  const baseCommitSha = form.get("baseCommitSha");
  const dirty = form.get("dirty");
  return {
    baseCommitSha: typeof baseCommitSha === "string" && baseCommitSha !== "" ? baseCommitSha : null,
    dirty:
      dirty === null || dirty === ""
        ? null
        : dirty === "true"
          ? true
          : dirty === "false"
            ? false
            : dirty,
  };
}

// The narrow persistence port this slice actually needs.
export type ProjectLifecycleStore = Pick<
  Store,
  | "enqueueJob"
  | "getGitCredential"
  | "getProject"
  | "getReleaseSource"
  | "listProjectJobs"
  | "requestProjectDeletion"
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
    // Multipart replaces the project's source with a fresh upload — the
    // `eveland deploy` loop. Any project accepts one; how it was created only
    // decides what the JSON sync below can do. Promoting an upload onto a git
    // project is a hotfix: production then runs source the repository does
    // not have, which the JSON sync below refuses to replace unconfirmed.
    if (isMultipartRequest(c)) {
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
      const provenance = uploadProvenanceSchema.safeParse(readUploadProvenance(form));
      if (!provenance.success) {
        return c.json({ error: "Invalid source provenance", issues: provenance.error.issues }, 400);
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
        origin: sourceUploadOrigin(c),
        uploadedBy: currentUserId(c),
        baseCommitSha: provenance.data.baseCommitSha,
        dirty: provenance.data.dirty,
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
    // Promoting the synced commit over a hotfix upload is the one way to lose
    // uncommitted production source silently, so it needs saying twice.
    if (syncOptions.data.promote && !syncOptions.data.confirmDrift) {
      const drift = deriveSourceDrift(
        project.importKind,
        project.releaseId ? await store.getReleaseSource(project.releaseId) : null,
      );
      if (drift.drifted) {
        return c.json(
          {
            error:
              "Production runs a hotfix upload that the repository does not have. Syncing and promoting replaces it with the repository's commit; send confirmDrift: true to do that.",
            drift,
          },
          409,
        );
      }
    }
    const host = normalizeGitHttpHost(project.gitUrl);
    const storedCredential = host ? await store.getGitCredential(currentUserId(c), host) : null;
    const job = await store.enqueueJob(projectId, "import_source", {
      importKind: "git",
      gitUrl: project.gitUrl,
      origin: "git-sync",
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
