import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Scaffolds a new agent project from the in-tree starter template. The
 * template ships with the source tree (templates/starter-agent) and is built
 * against the current eve compatibility window by CI, so a fresh init is
 * always deployable against the platform at the same commit — no version
 * rewriting needed at init time.
 *
 * The template lives outside this package, so it is reachable from a source
 * checkout but not from the published tarball: `init` is checkout-only until
 * it is reworked to delegate scaffolding to `eve init` and patch the result.
 * `templateDirProblem` says so plainly instead of letting the copy fail with
 * a bare ENOENT.
 */

export function defaultTemplateDir(): string {
  return fileURLToPath(new URL("../../../../templates/starter-agent/", import.meta.url));
}

export async function initProject(input: {
  targetDir: string;
  templateDir?: string;
}): Promise<{ projectName: string; files: string[] }> {
  const templateDir = input.templateDir ?? defaultTemplateDir();
  const problem = await templateDirProblem(templateDir);
  if (problem) throw new Error(problem);
  const targetDir = path.resolve(input.targetDir);
  const projectName = normalizeProjectName(path.basename(targetDir));

  await mkdir(targetDir, { recursive: true });
  const existing = await readdir(targetDir);
  if (existing.length > 0) {
    throw new Error(`${targetDir} is not empty — init only scaffolds into a new directory.`);
  }

  await cp(templateDir, targetDir, { recursive: true });

  const packageJsonPath = path.join(targetDir, "package.json");
  const manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  manifest.name = projectName;
  await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const files: string[] = [];
  await collectFiles(targetDir, targetDir, files);
  return { projectName, files: files.sort() };
}

export async function templateDirProblem(templateDir: string): Promise<string | null> {
  try {
    await readdir(templateDir);
    return null;
  } catch {
    return (
      `The starter template is missing at ${templateDir}.\n` +
      "`eveland init` scaffolds from the template in the platform source tree, so it " +
      "runs only from a checkout — not from an npm install of this package. Clone " +
      "https://github.com/evelandhq/eveland and run `pnpm eveland init` there."
    );
  }
}

function normalizeProjectName(basename: string): string {
  const name = basename
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!name) throw new Error(`Cannot derive a project name from '${basename}'.`);
  return name;
}

async function collectFiles(root: string, dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(root, full, out);
    else out.push(path.relative(root, full));
  }
}
