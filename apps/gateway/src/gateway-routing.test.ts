import { describe, expect, test } from "vitest";
import type { ResolvedAgentRoute } from "@eveland/core/contracts";
import { resolveTarget } from "./gateway-routing.js";
import type { GatewayRepository } from "./gateway-types.js";

const repository = {
  async getDeployment() {
    return null;
  },
} as unknown as GatewayRepository;

function routeWith(targets: Array<{ deploymentId: string; weight: number; status: string; hostPort: number }>): ResolvedAgentRoute {
  return {
    id: "route_failover",
    projectId: "proj_failover",
    hostname: "failover.agent.localhost",
    kind: "stable",
    policyRevision: 3,
    targets: targets.map((target) => ({
      routeId: "route_failover",
      variantName: null,
      ...target,
    })),
  } as unknown as ResolvedAgentRoute;
}

describe("resolveTarget under partial target failure", () => {
  test("routes to the surviving target when the other target of a 9000/1000 split is down", async () => {
    const route = routeWith([
      { deploymentId: "dep_alive", weight: 9000, status: "running", hostPort: 41001 },
      { deploymentId: "dep_dead", weight: 1000, status: "failed", hostPort: 41002 },
    ]);

    await expect(resolveTarget(repository, route, null, "affinity-key")).resolves.toMatchObject({
      deploymentId: "dep_alive",
    });
  });

  test("fails over to a zero-weight target when the full-weight target is down", async () => {
    const route = routeWith([
      { deploymentId: "dep_primary_down", weight: 10_000, status: "failed", hostPort: 41003 },
      { deploymentId: "dep_standby", weight: 0, status: "running", hostPort: 41004 },
    ]);

    // A 500/503 while a healthy policy target exists is worse than serving
    // from the drained-out side; pinned sessions keep their binding anyway.
    await expect(resolveTarget(repository, route, null, "affinity-key")).resolves.toMatchObject({
      deploymentId: "dep_standby",
    });
  });

  test("keeps weighted selection when both targets are healthy", async () => {
    const route = routeWith([
      { deploymentId: "dep_a", weight: 9000, status: "running", hostPort: 41005 },
      { deploymentId: "dep_b", weight: 1000, status: "running", hostPort: 41006 },
    ]);

    const target = await resolveTarget(repository, route, null, "affinity-key");
    expect(["dep_a", "dep_b"]).toContain(target?.deploymentId);
  });

  test("returns null when no target is eligible", async () => {
    const route = routeWith([
      { deploymentId: "dep_x", weight: 9000, status: "failed", hostPort: 41007 },
      { deploymentId: "dep_y", weight: 1000, status: "stopped", hostPort: 41008 },
    ]);

    await expect(resolveTarget(repository, route, null, "affinity-key")).resolves.toBeNull();
  });
});
