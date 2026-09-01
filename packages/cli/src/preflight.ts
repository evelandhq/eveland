import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Local packaging preflight for `eveland deploy`: catches, in under a second
 * and before any upload, the failures the platform would otherwise surface
 * minutes later (or worse, absorb silently).
 *
 * Mirrors the worker's source scan rules: same ignored directories, the
 * NUL-byte binary rule (binaries are silently dropped server-side and once
 * poisoned the import pipeline), and the per-file text ceiling.
 */

// Mirrors apps/worker/src/source/scan.ts.
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".eve",
]);
export const MAX_TEXT_FILE_BYTES = 256 * 1024;
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

export type ProjectFile = { name: string; data: Buffer };

export type PreflightResult = {
  files: ProjectFile[];
  totalBytes: number;
  eveSpecifier: string | null;
  projectName: string | null;
  problems: string[];
};

export async function collectProjectFiles(root: string): Promise<PreflightResult> {
  const files: ProjectFile[] = [];
  const problems: string[] = [];
  await walk(root, "", files);
  files.sort((a, b) => a.name.localeCompare(b.name));

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
      };
      projectName = parsed.name ?? null;
      eveSpecifier = parsed.dependencies?.eve ?? null;
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

  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.data.length;
    if (file.data.includes(0)) {
      problems.push(
        `${file.name} is a binary file — the platform silently drops binaries from imports; remove it.`,
      );
    } else if (file.data.length > MAX_TEXT_FILE_BYTES) {
      problems.push(
        `${file.name} is ${Math.round(file.data.length / 1024)} KiB — files over 256 KiB are dropped from imports.`,
      );
    }
  }
  if (totalBytes > MAX_ARCHIVE_BYTES) {
    problems.push(
      `Project source is ${Math.round(totalBytes / 1024 / 1024)} MiB — over the ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB upload cap.`,
    );
  }

  return { files, totalBytes, eveSpecifier, projectName, problems };
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

async function walk(root: string, prefix: string, out: ProjectFile[]): Promise<void> {
  const dir = path.join(root, prefix);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(root, rel, out);
      continue;
    }
    if (entry.isSymbolicLink()) continue; // the extractor rejects symlinks
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
    out.push({ name: rel, data: await readFile(path.join(dir, entry.name)) });
  }
}
