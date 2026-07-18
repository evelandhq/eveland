export class RuntimeInstanceDrainingError extends Error {
  constructor() {
    super("RuntimeInstance is draining; retry activation after it stops.");
    this.name = "RuntimeInstanceDrainingError";
  }
}

export class ProjectSlugConflictError extends Error {
  constructor() {
    super("Project name is already in use.");
    this.name = "ProjectSlugConflictError";
  }
}

export function projectDeletionSourcePaths(payloads: unknown[]): string[] {
  const paths = new Set<string>();
  for (const payload of payloads) {
    if (typeof payload !== "object" || payload === null) continue;
    const input = payload as { sourcePath?: unknown; sourcePaths?: unknown };
    if (typeof input.sourcePath === "string") paths.add(input.sourcePath);
    if (Array.isArray(input.sourcePaths)) {
      for (const sourcePath of input.sourcePaths) {
        if (typeof sourcePath === "string") paths.add(sourcePath);
      }
    }
  }
  return [...paths];
}

export const DEFAULT_TEAM_ID = "team_local";
