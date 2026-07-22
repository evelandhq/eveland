import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import ignoreModule, { type Ignore } from "ignore";

export type SnapshotFile = {
  path: string;
  content: Buffer;
  mode: number;
};

export type ProjectSnapshot = {
  root: string;
  files: SnapshotFile[];
  ignoreFile: ".evelandignore" | ".vercelignore" | ".gitignore" | null;
  digest: string;
};

const ignoreCandidates = [
  ".evelandignore",
  ".vercelignore",
  ".gitignore",
] as const;
const hardExcludedDirectories = new Set([
  ".git",
  ".eveland",
  ".ssh",
  ".aws",
  "node_modules",
]);
const hardExcludedFiles = new Set([
  ".npmrc",
  ".yarnrc",
  ".netrc",
  ".evelandignore",
  ".vercelignore",
]);
const createIgnore = ignoreModule as unknown as () => Ignore;

export async function collectProjectFiles(inputRoot: string): Promise<ProjectSnapshot> {
  const root = await realpath(path.resolve(inputRoot));
  const { matcher, ignoreFile } = await loadIgnoreFile(root);
  const files: SnapshotFile[] = [];
  const visitedDirectories = new Set<string>();

  async function walk(absoluteDir: string, relativeDir = ""): Promise<void> {
    const canonicalDir = await realpath(absoluteDir);
    if (visitedDirectories.has(canonicalDir)) {
      throw new Error(`Symlink cycle detected at ${relativeDir || "."}.`);
    }
    visitedDirectories.add(canonicalDir);
    try {
      const entries = await readdir(absoluteDir, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relativePath = path.posix.join(
          relativeDir,
          entry.name,
        );
        if (isHardExcluded(relativePath)) continue;
        if (matcher.ignores(relativePath)) continue;

        const absolutePath = path.join(absoluteDir, entry.name);
        const metadata = await lstat(absolutePath);
        if (metadata.isSymbolicLink()) {
          const target = await realpath(absolutePath);
          if (!isWithinRoot(root, target)) {
            throw new Error(`Symlink escapes the project root: ${relativePath}`);
          }
          const targetRelativePath = path
            .relative(root, target)
            .split(path.sep)
            .join(path.posix.sep);
          if (isHardExcluded(targetRelativePath)) continue;
          const targetMetadata = await stat(target);
          if (targetMetadata.isDirectory()) {
            await walk(target, relativePath);
          } else if (targetMetadata.isFile()) {
            files.push({
              path: relativePath,
              content: await readFile(target),
              mode: targetMetadata.mode & 0o777,
            });
          }
          continue;
        }
        if (metadata.isDirectory()) {
          await walk(absolutePath, relativePath);
        } else if (metadata.isFile()) {
          files.push({
            path: relativePath,
            content: await readFile(absolutePath),
            mode: metadata.mode & 0o777,
          });
        }
      }
    } finally {
      visitedDirectories.delete(canonicalDir);
    }
  }

  await walk(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.mode));
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }

  return {
    root,
    files,
    ignoreFile,
    digest: `sha256:${hash.digest("hex")}`,
  };
}

async function loadIgnoreFile(root: string) {
  for (const candidate of ignoreCandidates) {
    try {
      const contents = await readFile(path.join(root, candidate), "utf8");
      return { matcher: createIgnore().add(contents), ignoreFile: candidate };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { matcher: createIgnore(), ignoreFile: null };
}

function isHardExcluded(relativePath: string): boolean {
  const segments = relativePath.split("/");
  if (segments.some((segment) => hardExcludedDirectories.has(segment))) return true;
  const basename = segments.at(-1) ?? "";
  if (hardExcludedFiles.has(basename)) return true;
  if (basename === ".env.example") return false;
  return basename === ".env" || basename.startsWith(".env.");
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
