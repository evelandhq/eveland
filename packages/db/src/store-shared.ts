export class RuntimeInstanceDrainingError extends Error {
  constructor() {
    super("RuntimeInstance is draining; retry activation after it stops.");
    this.name = "RuntimeInstanceDrainingError";
  }
}

/** The Project has no stable route to promote onto. */
export class ProjectRouteNotFoundError extends Error {
  constructor() {
    super("Project route not found.");
    this.name = "ProjectRouteNotFoundError";
  }
}

/** No such Deployment, or it belongs to a different Project. */
export class DeploymentNotFoundError extends Error {
  constructor(message = "Deployment does not belong to this project.") {
    super(message);
    this.name = "DeploymentNotFoundError";
  }
}

/** The Deployment exists but is not in a state that can take the stable route. */
export class DeploymentNotPromotableError extends Error {
  constructor(message = "A promoted deployment must be running.") {
    super(message);
    this.name = "DeploymentNotPromotableError";
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
