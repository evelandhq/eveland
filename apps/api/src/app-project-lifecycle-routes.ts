import { normalizeGitHttpHost } from "@eveland/core/ids";
import { toPublicJob } from "@eveland/core/jobs";
import { type Store } from "@eveland/db";
import type { ApiApp } from "./app-types.js";
import { buildDeploySchema, syncSourceSchema } from "./app-schemas.js";
import { currentUserId } from "./app-support.js";

// The narrow persistence port this slice actually needs.
export type ProjectLifecycleStore = Pick<
  Store,
  "enqueueJob" | "getGitCredential" | "getProject" | "listProjectJobs" | "requestProjectDeletion"
>;

export function registerProjectLifecycleRoutes(input: {
  app: ApiApp;
  store: ProjectLifecycleStore;
}): void {
  const { app, store } = input;
  app.get("/projects/:projectId/jobs", async (c) => {
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

  app.delete("/projects/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const request = await store.requestProjectDeletion(projectId);
    if (request.outcome === "not_found") return c.json({ error: "Project not found" }, 404);
    if (request.outcome === "already_deleting")
      return c.json({ error: "Project is being deleted" }, 409);
    return c.json({ job: toPublicJob(request.job) }, 202);
  });

  app.post("/projects/:projectId/build-deploy", async (c) => {
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

  app.post("/projects/:projectId/sync-source", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
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

  app.post("/projects/:projectId/restart", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const job = await store.enqueueJob(projectId, "restart_deployment");
    return c.json({ job: toPublicJob(job) }, 202);
  });
}
