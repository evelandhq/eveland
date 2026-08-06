import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectImportKind, ScheduleRecord } from "@evelandhq/core/contracts";
import { getNextRunAt } from "@evelandhq/core/schedules";
import { inspectEveProject, type SourceFile } from "@evelandhq/core/source";

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".eve",
]);
const maxTextFileBytes = 256 * 1024;

export type SourceScanResult = {
  kind: ProjectImportKind;
  sourcePath: string;
  commitSha: string | null;
  summary: Record<string, unknown>;
  envVars: string[];
  files: Array<{ path: string; content: string }>;
  schedules: Array<Omit<ScheduleRecord, "id" | "projectId">>;
};

export async function scanEveSource(input: {
  kind: ProjectImportKind;
  sourcePath: string;
  commitSha?: string | null;
}): Promise<SourceScanResult> {
  const files = await collectSourceFiles(input.sourcePath);
  const inspection = inspectEveProject(files);
  const runtimeCommandContext = await inspectRuntimeCommandContext(input.sourcePath);

  if (!inspection.valid) {
    throw new Error(`Invalid eve project: ${inspection.errors.join(" ")}`);
  }

  return {
    kind: input.kind,
    sourcePath: input.sourcePath,
    commitSha: input.commitSha ?? null,
    summary: {
      layout: inspection.layout,
      projectName: inspection.projectName,
      eveVersion: inspection.eveVersion,
      capabilities: inspection.capabilities,
      runtimeCommandContext,
      ...inspection.summary,
    },
    envVars: inspection.envVars,
    files: files.map((file) => ({ path: file.path, content: file.content ?? "" })),
    schedules: inspection.schedules.map((schedule) => {
      if (schedule.kind === "markdown") {
        return {
          name: schedule.key,
          kind: schedule.kind,
          cron: schedule.cron,
          timezone: "UTC",
          enabled: true,
          executable: true,
          sourcePath: schedule.sourcePath,
          nextRunAt: getNextRunAt(schedule.cron).toISOString(),
        };
      }

      return {
        name: schedule.key,
        kind: "typescript" as const,
        cron: null,
        timezone: null,
        enabled: true,
        executable: true,
        sourcePath: schedule.sourcePath,
        nextRunAt: null,
      };
    }),
  };
}

async function collectSourceFiles(rootDir: string, relativeDir = ""): Promise<SourceFile[]> {
  const absoluteDir = path.join(rootDir, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files: SourceFile[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") {
      continue;
    }
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const relativePath = path.posix.join(
      relativeDir.split(path.sep).join(path.posix.sep),
      entry.name,
    );
    const absolutePath = path.join(rootDir, relativePath);

    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(rootDir, relativePath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const stats = await stat(absolutePath);
    if (stats.size > maxTextFileBytes) {
      continue;
    }

    try {
      files.push({
        path: relativePath,
        content: await readFile(absolutePath, "utf8"),
      });
    } catch {
      // Binary or unreadable files are not needed for the source browser.
    }
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function inspectRuntimeCommandContext(rootDir: string): Promise<{
  packageManager: "npm" | "pnpm";
  hasLockfile: boolean;
}> {
  const [hasPnpmLockfile, hasNpmLockfile] = await Promise.all([
    rootFileExists(rootDir, "pnpm-lock.yaml"),
    rootFileExists(rootDir, "package-lock.json"),
  ]);
  return hasPnpmLockfile
    ? { packageManager: "pnpm", hasLockfile: true }
    : { packageManager: "npm", hasLockfile: hasNpmLockfile };
}

async function rootFileExists(rootDir: string, fileName: string): Promise<boolean> {
  try {
    return (await stat(path.join(rootDir, fileName))).isFile();
  } catch {
    return false;
  }
}
