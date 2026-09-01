import path from "node:path";
import { ApiError, apiRequest, type FetchLike } from "./api-client.ts";
import { collectProjectFiles, eveSpecifierProblem } from "./preflight.ts";
import { createZipArchive } from "./zip.ts";

/**
 * `eveland deploy`: local preflight → zip upload → server-side build (log
 * lines streamed to the terminal as they land) → promote.
 *
 * Promote is the default on purpose: a redeploy without promote leaves
 * routes AND the scheduler target on the old deployment — the known gotcha
 * this CLI exists to spare people from. --no-promote opts out explicitly.
 */

const POLL_INTERVAL_MS = 1_200;
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1_000;

type PublicJob = {
  id: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed";
  lastError: string | null;
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
};

export type DeployResult = {
  slug: string;
  projectId: string;
  deploymentId: string | null;
  promoted: boolean;
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
  promote: boolean;
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
  const source = await collectProjectFiles(path.resolve(input.dir));
  if (source.problems.length > 0) {
    throw new Error(`The project cannot be deployed:\n  - ${source.problems.join("\n  - ")}`);
  }
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
  if (existing && existing.importKind !== "zip") {
    throw new Error(
      `Project '${slug}' was imported from git — push to its repository and use the Dashboard's sync, or deploy under a different --name.`,
    );
  }

  // Jobs already on the record are not ours; only report what this deploy
  // enqueues.
  const seenJobs = new Set<string>(
    existing ? (await fetchJobs(existing.id)).map((job) => job.id) : [],
  );
  const seenLogs = new Set<string>(
    existing ? (await fetchLogs(existing.id)).map((log) => log.id) : [],
  );

  let projectId: string;
  if (existing) {
    const form = new FormData();
    form.set("archive", new File([new Uint8Array(archive)], "source.zip"));
    form.set("deploy", "true");
    await request<{ job: PublicJob }>(`/api/projects/${existing.id}/sync-source`, {
      method: "POST",
      body: form,
    });
    projectId = existing.id;
  } else {
    const form = new FormData();
    form.set("name", slug);
    form.set("archive", new File([new Uint8Array(archive)], "source.zip"));
    form.set("deployAfterImport", "true");
    const created = await request<{ project: { id: string } }>("/api/projects", {
      method: "POST",
      body: form,
    });
    projectId = created.project.id;
  }

  // Watch the import -> build chain, printing build logs as they land.
  const deadline = now() + DEPLOY_TIMEOUT_MS;
  let lastBuildJob: PublicJob | null = null;
  for (;;) {
    if (now() >= deadline) throw new Error("Timed out waiting for the build to finish.");
    await sleep(POLL_INTERVAL_MS);
    for (const log of await fetchLogs(projectId)) {
      if (seenLogs.has(log.id)) continue;
      seenLogs.add(log.id);
      io.print(`  ${log.line}`);
    }
    const jobs = (await fetchJobs(projectId)).filter((job) => !seenJobs.has(job.id));
    const failed = jobs.find((job) => job.status === "failed");
    if (failed) {
      throw new Error(
        `${failed.type === "import_source" ? "Import" : "Build"} failed: ${failed.lastError ?? "unknown error"}`,
      );
    }
    lastBuildJob = jobs.find((job) => job.type === "build_deploy") ?? null;
    if (lastBuildJob?.status === "completed") break;
  }

  const { deployments } = await request<{
    deployments: Array<{ id: string; status: string }>;
  }>(`/api/projects/${projectId}/deployments`);
  const built = deployments.find((deployment) => deployment.status === "running") ?? null;
  if (!built) throw new Error("The build completed but no running deployment was found.");

  if (input.promote) {
    await request(`/api/projects/${projectId}/deployments/${built.id}/promote`, {
      method: "POST",
    });
    io.print("Promoted: routes and the schedule target now point at this deployment.");
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
    deploymentId: built.id,
    promoted: input.promote,
    stableUrl: endpoints.stable,
    previewUrls: endpoints.previews,
  };

  async function fetchJobs(id: string): Promise<PublicJob[]> {
    const { jobs } = await request<{ jobs: PublicJob[] }>(
      `/api/projects/${id}/jobs?include=deployment`,
    );
    return jobs;
  }

  async function fetchLogs(id: string): Promise<Array<{ id: string; line: string }>> {
    try {
      const { logs } = await request<{ logs: Array<{ id: string; line: string }> }>(
        `/api/projects/${id}/logs?type=build`,
      );
      return logs;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return [];
      throw error;
    }
  }
}
