import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export type OutboxFile = {
  path: string;
  size: number;
  modifiedAtMs: number;
};

export async function listOutboxFiles(root: string, suffix: RegExp): Promise<OutboxFile[]> {
  const files: OutboxFile[] = [];
  await walk(path.resolve(root), files, suffix);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(directory: string, files: OutboxFile[], suffix: RegExp): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.name === "quarantine") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath, files, suffix);
    } else if (entry.isFile() && suffix.test(entry.name)) {
      const metadata = await stat(entryPath);
      files.push({ path: entryPath, size: metadata.size, modifiedAtMs: metadata.mtimeMs });
    }
  }
}
