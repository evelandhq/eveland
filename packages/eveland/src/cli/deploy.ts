import path from "node:path";
import { ApiError, apiRequest, type FetchLike } from "./api-client.ts";
import {
  describeGitProvenance,
  detectGitProvenance,
  type GitProvenance,
} from "./git-provenance.ts";
import { collectProjectFiles, eveSpecifierProblem } from "./preflight.ts";
import { createZipArchive } from "./zip.ts";

/**
 * `eveland deploy`: local preflight → zip upload → server-side build (log
 * lines streamed to the terminal as they land) with promote requested up
 * front, so the worker promotes inside the build job.
 *
 * Promote is the default on purpose for zip projects: a redeploy without
 * promote leaves routes AND the scheduler target on the old deployment — the
 * known gotcha this CLI exists to spare people from. --no-promote opts out
 * explicitly. Promotion travels with the deploy request rather than as a
 * second call from the CLI, so a terminal closed mid-watch cannot strand
 * routes on the old deployment, and a concurrent deploy from the Dashboard
 * can never be the one this run promotes.
 *
 * A project imported from git is the exception: an upload to it deploys as
 * a preview only, and --promote is refused. Promoting an upload would put
 * production on a revision the next repository sync silently replaces, and
 * nothing records that drift yet. The upload still carries the commit it was
 * based on and whether the tree was dirty, so the Dashboard can say so.
 */

const POLL_INTERVAL_MS = 1_200;
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1_000;

type PublicJob = {
  id: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed";
  lastError: string | null;
  /** The job that queued this one: a chained build names its import. */
  parentJobId: string | null;
  /** The deployment a build produced, recorded before the job completes. */
  deploymentId: string | null;
};

type ProjectListItem = {
  id: string;
  slug: string;
  importKind: "git" | "zip";
  deploymentStatus: string;
  deploymentId: string | null;
};

type DeployIo = {
  fetchImpl?: FetchLike;
  print: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Replaces the real git probe; unset runs `git` in the deploy directory. */
  detectProvenance?: (dir: string) => Promise<GitProvenance | null>;
};

export type DeployResult = {
  slug: string;
  projectId: string;
  importKind: "git" | "zip";
  deploymentId: string;
  promoted: boolean;
  provenance: GitProvenance | null;
  stableUrl: string | null;
  previewUrls: string[];
};

export function projectSlugFrom(explicit: string | undefined, fallback: string): string {
  const source = explicit ?? fallback;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 53)
    .replace(/-+$/g, "");
  if (!slug) throw new Error(`Cannot derive a project slug from '${source}'.`);
  return slug;
}

export async function runDeploy(input: {
  origin: string;
  token: string;
  dir: string;
  name?: string;
  /** Unset means the project's default: promote a zip project, preview a git one. */
  promote?: boolean;
  io: DeployIo;
}): Promise<DeployResult> {
  const { origin, token, io } = input;
  const sleep = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = io.now ?? Date.now;
  const request = <T>(requestPath: string, init?: { method?: string; body?: FormData }) =>
    apiRequest<T>({
      origin,
      path: requestPath,
      token,
      fetchImpl: io.fetchImpl,
      ...(init?.method ? { method: init.method } : {}),
      ...(init?.body !== undefined ? { multipart: init.body } : {}),
    });

  // Local preflight: fail in under a second, before any upload.
  const dir = path.resolve(input.dir);
  const source = await collectProjectFiles(dir);
  if (source.problems.length > 0) {
    throw new Error(`The project cannot be deployed:\n  - ${source.problems.join("\n  - ")}`);
  }
  for (const warning of source.warnings) io.print(`Warning: ${warning}`);
  const provenance = await (io.detectProvenance ?? detectGitProvenance)(dir);
  io.print(describeGitProvenance(provenance));
  const instance = await request<{ eve: { supportedRanges: string[] } }>("/api/instance");
  const versionProblem = eveSpecifierProblem(source.eveSpecifier, instance.eve.supportedRanges);
  if (versionProblem) throw new Error(versionProblem);

  const slug = projectSlugFrom(
    input.name,
    source.projectName ?? path.basename(path.resolve(input.dir)),
  );
  const archive = createZipArchive(source.files);
  io.print(
    `Uploading ${source.files.length} files (${Math.max(1, Math.round(archive.length / 1024))} KiB) as '${slug}' to ${origin}...`,
  );

  const { projects } = await request<{ projects: ProjectListItem[] }>("/api/projects");
  const existing = projects.find((candidate) => candidate.slug === slug) ?? null;
  const importKind = existing?.importKind ?? "zip";
  if (importKind === "git" && input.promote === true) {
    throw new Error(
      `Project '${slug}' was imported from git, and uploads to it deploy as previews only. Drop --promote to deploy a preview and promote it from the Dashboard once it builds, or push to the repository and sync it to promote a commit.`,
    );
  }
  const promote = input.promote ?? importKind === "zip";

  // Logs advance through the server-side `after` cursor, so no poll ever
  // re-downloads the project's history. The watermark from a limit=1 read is
  // valid even when the project has no logs yet, so no later poll ever needs
  // an unbounded read.
  let logCursor: string | null = null;
  if (existing) logCursor = (await fetchLogs(existing.id, "limit=1")).cursor;

  // This deploy is identified by the import job it queues; the build the
  // worker chains from that import names it as parent. Jobs from other
  // deploys on the same project are never ours, however new they are.
  let projectId: string;
  let importJobId: string;
  if (existing) {
    const form = new FormData();
    form.set("archive", new File([new Uint8Array(archive)], "source.zip"));
    form.set("deploy", "true");
    if (promote) form.set("promote", "true");
    if (provenance) {
      form.set("baseCommitSha", provenance.baseCommitSha);
      form.set("dirty", String(provenance.dirty));
    }
    const { job } = await request<{ job: PublicJob }>(`/api/projects/${existing.id}/sync-source`, {
      method: "POST",
      body: form,
    });
    projectId = existing.id;
    importJobId = job.id;
  } else {
    // Preflight-first, like the Dashboard: the worker validates the source
    // BEFORE any project exists, so a failed validation never leaves a
    // failed project squatting on the slug.
    const preflightForm = new FormData();
    preflightForm.set("archive", new File([new Uint8Array(archive)], "source.zip"));
    const submitted = await request<{ preflight: { id: string } }>("/api/source-preflights", {
      method: "POST",
      body: preflightForm,
    });
    const preflight = await waitForPreflight(submitted.preflight.id);
    if (preflight.status !== "completed") {
      throw new Error(`Source validation failed: ${preflight.error ?? "unknown reason"}`);
    }
    const created = await apiRequest<{ project: { id: string } }>({
      origin,
      path: "/api/projects",
      token,
      fetchImpl: io.fetchImpl,
      json: {
        name: slug,
        preflightId: submitted.preflight.id,
        deployAfterImport: true,
        promoteAfterDeploy: promote,
        ...(provenance ? { baseCommitSha: provenance.baseCommitSha, dirty: provenance.dirty } : {}),
      },
    });
    projectId = created.project.id;
    // The project is created together with its import job, so the oldest
    // import on the brand-new project is the one this create queued.
    const importJob = (await fetchJobs(projectId))
      .filter((job) => job.type === "import_source")
      .at(-1);
    if (!importJob) {
      throw new Error(`Project '${slug}' was created but no import job was queued for it.`);
    }
    importJobId = importJob.id;
  }

  // Watch the import -> build chain, printing build logs as they land.
  const deadline = now() + DEPLOY_TIMEOUT_MS;
  let buildJob: PublicJob | null = null;
  for (;;) {
    if (now() >= deadline) throw new Error("Timed out waiting for the build to finish.");
    await sleep(POLL_INTERVAL_MS);
    // Always cursor-anchored (a fresh project starts from position 0 — its
    // history began with this deploy) and drained to the tip: a full page
    // means more lines are already waiting.
    for (;;) {
      const page = await fetchLogs(
        projectId,
        `after=${encodeURIComponent(logCursor ?? "0")}&limit=500`,
      );
      for (const log of page.logs) io.print(`  ${log.line}`);
      logCursor = page.cursor;
      if (page.logs.length < 500) break;
    }
    const jobs = await fetchJobs(projectId);
    const importJob = jobs.find((job) => job.id === importJobId) ?? null;
    buildJob =
      jobs.find((job) => job.type === "build_deploy" && job.parentJobId === importJobId) ?? null;
    if (importJob?.status === "failed") {
      throw new Error(`Import failed: ${importJob.lastError ?? "unknown error"}`);
    }
    if (buildJob?.status === "failed") {
      throw new Error(`Build failed: ${buildJob.lastError ?? "unknown error"}`);
    }
    if (buildJob?.status === "completed") break;
  }

  // The worker names the deployment on the job before the job can complete;
  // a completed build without one is a platform defect to report, not a gap
  // to paper over by picking the project's newest running deployment.
  const deploymentId = buildJob?.deploymentId ?? null;
  if (!deploymentId) {
    throw new Error(
      "The build completed but did not record which deployment it produced. Check the project's deployments in the Dashboard.",
    );
  }

  if (promote) {
    // Promotion ran inside the build job, after its routes existed; a promote
    // that fails fails the job, so a completed build is a promoted one.
    io.print("Promoted: routes and the schedule target now point at this deployment.");
  } else if (importKind === "git") {
    io.print(
      `Deployed as a preview: '${slug}' was imported from git, and uploads to it never promote. Routes and schedules stay on the current deployment; promote the preview from the Dashboard, or push and sync the repository.`,
    );
  } else {
    io.print(
      "Deployed as a preview (--no-promote): routes and schedules stay on the old deployment.",
    );
  }

  const endpoints = await request<{ stable: string | null; previews: string[] }>(
    `/api/projects/${projectId}/endpoints`,
  ).catch(() => ({ stable: null, previews: [] as string[] }));

  return {
    slug,
    projectId,
    importKind,
    deploymentId,
    promoted: promote,
    provenance,
    stableUrl: endpoints.stable,
    previewUrls: endpoints.previews,
  };

  async function waitForPreflight(
    preflightId: string,
  ): Promise<{ status: string; error: string | null }> {
    const preflightDeadline = now() + DEPLOY_TIMEOUT_MS;
    for (;;) {
      const { preflight } = await request<{
        preflight: { status: string; error: string | null };
      }>(`/api/source-preflights/${preflightId}`);
      if (preflight.status !== "queued" && preflight.status !== "running") return preflight;
      if (now() >= preflightDeadline) {
        throw new Error("Timed out waiting for source validation.");
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  async function fetchJobs(id: string): Promise<PublicJob[]> {
    const { jobs } = await request<{ jobs: PublicJob[] }>(
      `/api/projects/${id}/jobs?include=deployment`,
    );
    return jobs;
  }

  async function fetchLogs(
    id: string,
    query: string,
  ): Promise<{ logs: Array<{ id: string; line: string }>; cursor: string }> {
    try {
      return await request<{ logs: Array<{ id: string; line: string }>; cursor: string }>(
        `/api/projects/${id}/logs?type=build&${query}`,
      );
    } catch (error) {
      // A transient 404 must not reset the cursor and replay history later.
      if (error instanceof ApiError && error.status === 404) {
        return { logs: [], cursor: logCursor ?? "0" };
      }
      throw error;
    }
  }
}
