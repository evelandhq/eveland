import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type LinkedProject = {
  projectId: string;
  instanceUrl: string;
};

export type ResolvedProjectConfig = LinkedProject & {
  linked: boolean;
};

export async function resolveProjectConfig(
  root: string,
  options: {
    projectId?: string;
    instanceUrl?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ResolvedProjectConfig> {
  const linked = await readLinkedProject(root);
  const env = options.env ?? process.env;
  const projectId =
    options.projectId?.trim() ||
    env.EVELAND_PROJECT_ID?.trim() ||
    linked?.projectId;
  if (!projectId) {
    throw new Error(
      "No Eveland project is linked. Run `eveland link --project <project-id>` or pass --project.",
    );
  }
  const instanceUrl = normalizeInstanceUrl(
    options.instanceUrl?.trim() ||
      env.EVELAND_URL?.trim() ||
      linked?.instanceUrl ||
      "http://localhost:3000",
  );
  return { projectId, instanceUrl, linked: linked !== null };
}

export async function linkProject(root: string, input: LinkedProject): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const directory = path.join(resolvedRoot, ".eveland");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(directory, "project.json"),
    `${JSON.stringify({
      projectId: input.projectId.trim(),
      instanceUrl: normalizeInstanceUrl(input.instanceUrl),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await ensureGitIgnored(resolvedRoot);
}

async function readLinkedProject(root: string): Promise<LinkedProject | null> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(path.resolve(root), ".eveland", "project.json"), "utf8"),
    ) as Partial<LinkedProject>;
    if (typeof raw.projectId !== "string" || typeof raw.instanceUrl !== "string") {
      throw new Error("Invalid .eveland/project.json: projectId and instanceUrl are required.");
    }
    return { projectId: raw.projectId, instanceUrl: normalizeInstanceUrl(raw.instanceUrl) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function normalizeInstanceUrl(value: string): string {
  const url = new URL(value);
  return url.toString().replace(/\/$/, "");
}

export function apiUrlForInstance(instanceUrl: string): string {
  return `${normalizeInstanceUrl(instanceUrl)}/api/eveland`;
}

async function ensureGitIgnored(root: string): Promise<void> {
  const gitignorePath = path.join(root, ".gitignore");
  let current = "";
  try {
    current = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const alreadyIgnored = current
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => [".eveland", ".eveland/", "/.eveland", "/.eveland/"].includes(line));
  if (alreadyIgnored) return;
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await writeFile(gitignorePath, `${current}${prefix}.eveland/\n`);
}
