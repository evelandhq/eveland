import { describe, expect, test } from "vitest";
import { affinityBucket, selectWeightedTarget, validateRouteTargets, isDeploymentProtected } from "./routing.js";

describe("route policy", () => {
  test("uses a deterministic 10,000 bucket and honors 90/10 then 50/50 weights", () => {
    const ninetyTen = [
      { deploymentId: "dep_a", weight: 9_000, variantName: "control" },
      { deploymentId: "dep_b", weight: 1_000, variantName: "candidate" },
    ];
    const fiftyFifty = ninetyTen.map((target) => ({ ...target, weight: 5_000 }));
    const keys = Array.from({ length: 1_000 }, (_, index) => `session-${index}`);

    expect(affinityBucket("same-key")).toBe(affinityBucket("same-key"));
    expect(keys.filter((key) => selectWeightedTarget(ninetyTen, key)?.deploymentId === "dep_b").length).toBeGreaterThan(60);
    expect(keys.filter((key) => selectWeightedTarget(ninetyTen, key)?.deploymentId === "dep_b").length).toBeLessThan(140);
    expect(keys.filter((key) => selectWeightedTarget(fiftyFifty, key)?.deploymentId === "dep_b").length).toBeGreaterThan(430);
  });

  test("rejects more than two targets, duplicate deployments, and invalid totals", () => {
    expect(() => validateRouteTargets([])).toThrow(/one or two/);
    expect(() => validateRouteTargets([{ deploymentId: "a", weight: 9_000, variantName: null }])).toThrow(/10,000/);
    expect(() => validateRouteTargets([
      { deploymentId: "a", weight: 5_000, variantName: null },
      { deploymentId: "a", weight: 5_000, variantName: null },
    ])).toThrow(/unique/);
    expect(() => validateRouteTargets([
      { deploymentId: "a", weight: 3_400, variantName: null },
      { deploymentId: "b", weight: 3_300, variantName: null },
      { deploymentId: "c", weight: 3_300, variantName: null },
    ])).toThrow(/one or two/);
  });

  test("protects route targets, active bindings, and the three newest artifacts", () => {
    expect(isDeploymentProtected({ deploymentId: "dep_a", routeTargetIds: new Set(["dep_a"]), activeBindingIds: new Set(), retainedIds: new Set() })).toBe(true);
    expect(isDeploymentProtected({ deploymentId: "dep_b", routeTargetIds: new Set(), activeBindingIds: new Set(["dep_b"]), retainedIds: new Set() })).toBe(true);
    expect(isDeploymentProtected({ deploymentId: "dep_c", routeTargetIds: new Set(), activeBindingIds: new Set(), retainedIds: new Set(["dep_c"]) })).toBe(true);
    expect(isDeploymentProtected({ deploymentId: "dep_old", routeTargetIds: new Set(), activeBindingIds: new Set(), retainedIds: new Set() })).toBe(false);
  });
});
