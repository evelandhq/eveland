import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";

/**
 * Local packaging preflight for `eveland deploy`: catches, in under a second
 * and before any upload, the failures the platform would otherwise surface
 * minutes later.
 *
 * The archive must be FAITHFUL to the local directory: the platform's Release
 * builds from the full uploaded tree (`cp -a`), and the server-side scanner's
 * dotfile/size/binary rules only shape the read-only Source projection — they
 * do not remove files from the build. So packaging excludes nothing but
 * `.git` and `node_modules`, and projection-only effects (binaries, oversized
 * files) are warnings, not refusals.
 */

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules"]);
/** Mirrors the server's default EVELAND_MAX_UPLOAD_BYTES. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Files above this are kept in the build but invisible in the Source page. */
export const SOURCE_PROJECTION_FILE_BYTES = 256 * 1024;

export type ProjectFile = { name: string; data: Buffer };

export type PreflightResult = {
  files: ProjectFile[];
  totalBytes: number;
  eveSpecifier: string | null;
  projectName: string | null;
  problems: string[];
  warnings: string[];
};

export async function collectProjectFiles(root: string): Promise<PreflightResult> {
  const problems: string[] = [];
  const warnings: string[] = [];

  // Sizes first: a stray multi-gigabyte file must fail the cap without ever
  // being read into memory.
  const entries: Array<{ name: string; size: number }> = [];
  await walk(root, "", entries);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > MAX_UPLOAD_BYTES) {
    problems.push(
      `Project source is ${Math.round(totalBytes / 1024 / 1024)} MiB — over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB upload cap.`,
    );
    return { files: [], totalBytes, eveSpecifier: null, projectName: null, problems, warnings };
  }

  const files: ProjectFile[] = [];
  for (const entry of entries) {
    files.push({ name: entry.name, data: await readFile(path.join(root, entry.name)) });
  }

  let eveSpecifier: string | null = null;
  let projectName: string | null = null;
  const manifest = files.find((file) => file.name === "package.json");
  if (!manifest) {
    problems.push("No package.json at the project root.");
  } else {
    try {
      const parsed = JSON.parse(manifest.data.toString("utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      projectName = parsed.name ?? null;
      // Same fallback the server's readDeclaredEveVersion applies.
      eveSpecifier = parsed.dependencies?.eve ?? parsed.devDependencies?.eve ?? null;
      if (!eveSpecifier) problems.push('package.json declares no "eve" dependency.');
    } catch {
      problems.push("package.json is not valid JSON.");
    }
  }

  const hasInstructions = files.some(
    (file) =>
      /^(agent\/)?instructions\.(md|ts)$/.test(file.name) ||
      /^(agent\/)?instructions\//.test(file.name),
  );
  if (!hasInstructions) {
    problems.push("Missing instructions.md, instructions.ts, or instructions/ (root or agent/).");
  }

  for (const file of files) {
    if (file.data.includes(0)) {
      warnings.push(`${file.name} is binary — it deploys, but stays invisible in the Source page.`);
    } else if (file.data.length > SOURCE_PROJECTION_FILE_BYTES) {
      warnings.push(
        `${file.name} is ${Math.round(file.data.length / 1024)} KiB — it deploys, but files over 256 KiB stay invisible in the Source page.`,
      );
    }
    if (/^\.env(\..+)?$/.test(file.name) && file.name !== ".env.example") {
      warnings.push(
        `${file.name} is included in the upload; its values become part of the source record — prefer \`eveland env set\` for real secrets.`,
      );
    }
  }

  return { files, totalBytes, eveSpecifier, projectName, problems, warnings };
}

/**
 * The platform's eve-specifier grammar, checked against the ranges the
 * instance reports (e.g. ["0.45.x", "0.47.x"]). The server re-validates at
 * import and activation; this only moves the same verdict earlier.
 */
export function eveSpecifierProblem(
  specifier: string | null,
  supportedRanges: readonly string[],
): string | null {
  const supported = `Eveland requires eve ${supportedRanges.join(" or ")}.`;
  if (!specifier) return `Missing "eve" dependency. ${supported}`;
  const match = /^([~^]?)(0\.\d+)(?:\.(\d+|[x*]))?$/.exec(specifier.trim());
  if (!match) return `Unsupported eve dependency "${specifier}". ${supported}`;
  const [, operator, minor, patch] = match;
  if (operator && !/^\d+$/.test(patch ?? "")) {
    return `Unsupported eve dependency "${specifier}". ${supported}`;
  }
  const line = `${minor}.x`;
  if (!supportedRanges.includes(line)) {
    return `eve ${specifier} is outside this instance's supported window. ${supported}`;
  }
  return null;
}

async function walk(
  root: string,
  prefix: string,
  out: Array<{ name: string; size: number }>,
): Promise<void> {
  const dir = path.join(root, prefix);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) await walk(root, rel, out);
      continue;
    }
    if (entry.isSymbolicLink()) continue; // the platform's extractor rejects symlinks
    if (!entry.isFile()) continue;
    out.push({ name: rel, size: (await lstat(path.join(dir, entry.name))).size });
  }
}
