import { readFile } from "node:fs/promises";
import path from "node:path";
import { apiRequest, type FetchLike } from "./api-client.ts";
import { projectSlugFrom } from "./deploy.ts";

/**
 * Resolves which project a command targets: an explicit --name wins,
 * otherwise the working directory's package.json name (the same rule deploy
 * uses to pick its slug), otherwise the directory basename.
 */
export async function resolveProject(input: {
  origin: string;
  token: string;
  name?: string;
  dir?: string;
  fetchImpl?: FetchLike;
}): Promise<{ id: string; slug: string; importKind: string }> {
  const dir = path.resolve(input.dir ?? ".");
  let manifestName: string | null = null;
  try {
    const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as {
      name?: string;
    };
    manifestName = manifest.name ?? null;
  } catch {
    // Not in a project directory; --name must carry the target.
  }
  const slug = projectSlugFrom(input.name, manifestName ?? path.basename(dir));
  const { projects } = await apiRequest<{
    projects: Array<{ id: string; slug: string; importKind: string }>;
  }>({
    origin: input.origin,
    path: "/api/projects",
    token: input.token,
    fetchImpl: input.fetchImpl,
  });
  const project = projects.find((candidate) => candidate.slug === slug);
  if (!project) {
    throw new Error(
      `No project '${slug}' on ${input.origin}. Pass --name <slug> or run from the project directory.`,
    );
  }
  return project;
}
