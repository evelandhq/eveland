import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".next", "drizzle"]);

function isTestFile(filePath: string): boolean {
  return (
    /\.test\.tsx?$/.test(filePath) ||
    /\.integration\.test\.tsx?$/.test(filePath) ||
    /\.test-support\.tsx?$/.test(filePath) ||
    /\.typecheck\.tsx?$/.test(filePath)
  );
}

function walk(absoluteDir: string): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      collected.push(...walk(path.join(absoluteDir, entry.name)));
      continue;
    }
    if (/\.(ts|tsx|mts)$/.test(entry.name)) collected.push(path.join(absoluteDir, entry.name));
  }
  return collected;
}

/** Repo-relative POSIX paths of source files under the given repo-relative root. */
export function listSourceFiles(
  relativeRoot: string,
  options: { includeTests?: boolean } = {},
): string[] {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];
  return walk(absoluteRoot)
    .map((absolute) => path.relative(repoRoot, absolute).replaceAll(path.sep, "/"))
    .filter((relative) => options.includeTests || !isTestFile(relative))
    .sort();
}

export function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const IMPORT_PATTERN =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

export function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

/** Resolves a relative specifier from a repo-relative file to a repo-relative file path, or null. */
export function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.join(path.posix.dirname(fromFile), specifier);
  const candidates = specifier.endsWith(".js")
    ? [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx")]
    : specifier.endsWith(".ts") || specifier.endsWith(".tsx") || specifier.endsWith(".mts")
      ? [base]
      : [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  for (const candidate of candidates) {
    if (existsSync(path.join(repoRoot, candidate))) return candidate;
  }
  return null;
}

export type Workspace = {
  name: string;
  directory: string;
  manifest: Record<string, unknown>;
};

export function listWorkspaces(): Workspace[] {
  const workspaces: Workspace[] = [];
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(repoRoot, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(repoRoot, group, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      workspaces.push({
        name: String(manifest.name),
        directory: `${group}/${entry.name}`,
        manifest,
      });
    }
  }
  return workspaces;
}
