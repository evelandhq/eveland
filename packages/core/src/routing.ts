import type { RouteTarget } from "./contracts.js";

export type RouteTargetInput = Pick<RouteTarget, "deploymentId" | "weight" | "variantName">;

export function validateRouteTargets(targets: RouteTargetInput[]): void {
  if (targets.length < 1 || targets.length > 2) throw new Error("A route must have one or two targets.");
  if (new Set(targets.map((target) => target.deploymentId)).size !== targets.length) {
    throw new Error("Route target deployments must be unique.");
  }
  if (targets.some((target) => !Number.isInteger(target.weight) || target.weight < 0 || target.weight > 10_000)) {
    throw new Error("Route target weights must be integer basis points between 0 and 10,000.");
  }
  if (targets.reduce((sum, target) => sum + target.weight, 0) !== 10_000) {
    throw new Error("Route target weights must total 10,000 basis points.");
  }
}

export function affinityBucket(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 10_000;
}

export function affinityBucketForRoute(routeId: string, policyRevision: number, affinityKey: string): number {
  return affinityBucket(`${routeId}:${policyRevision}:${affinityKey}`);
}

export function selectWeightedTarget<T extends RouteTargetInput>(
  targets: T[],
  affinityKey: string,
  route?: { id: string; policyRevision: number },
): T | null {
  validateRouteTargets(targets);
  const bucket = route ? affinityBucketForRoute(route.id, route.policyRevision, affinityKey) : affinityBucket(affinityKey);
  let upper = 0;
  for (const target of targets) {
    upper += target.weight;
    if (bucket < upper) return target;
  }
  return null;
}

export function isDeploymentProtected(input: {
  deploymentId: string;
  routeTargetIds: ReadonlySet<string>;
  activeBindingIds: ReadonlySet<string>;
  retainedIds: ReadonlySet<string>;
}): boolean {
  return input.routeTargetIds.has(input.deploymentId) || input.activeBindingIds.has(input.deploymentId) || input.retainedIds.has(input.deploymentId);
}
