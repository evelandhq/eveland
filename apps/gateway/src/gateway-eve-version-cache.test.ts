import type { EveVersionInfo } from "@evelandhq/core/source";
import { describe, expect, test, vi } from "vitest";
import { withDeploymentEveVersionCache } from "./gateway-eve-version-cache.js";

function versionInfo(deploymentId: string): EveVersionInfo {
  return {
    version: "0.38.3",
    expected: "a verified line",
    supportedRanges: [],
    supported: true,
    sourceRevisionId: `src-${deploymentId}`,
  };
}

describe("withDeploymentEveVersionCache", () => {
  test("resolves through the repository once and serves repeats from the cache", async () => {
    const lookup = vi.fn(async (deploymentId: string) => versionInfo(deploymentId));
    const cached = withDeploymentEveVersionCache({ getDeploymentEveVersion: lookup });

    await expect(cached.getDeploymentEveVersion("dep_1")).resolves.toMatchObject({
      sourceRevisionId: "src-dep_1",
    });
    await expect(cached.getDeploymentEveVersion("dep_1")).resolves.toMatchObject({
      sourceRevisionId: "src-dep_1",
    });
    await expect(cached.getDeploymentEveVersion("dep_2")).resolves.toMatchObject({
      sourceRevisionId: "src-dep_2",
    });

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenNthCalledWith(1, "dep_1");
    expect(lookup).toHaveBeenNthCalledWith(2, "dep_2");
  });

  test("shares one in-flight lookup between concurrent requests", async () => {
    let release!: (info: EveVersionInfo) => void;
    const lookup = vi.fn(
      (_deploymentId: string) =>
        new Promise<EveVersionInfo | null>((resolve) => (release = resolve)),
    );
    const cached = withDeploymentEveVersionCache({ getDeploymentEveVersion: lookup });

    const first = cached.getDeploymentEveVersion("dep_1");
    const second = cached.getDeploymentEveVersion("dep_1");
    release(versionInfo("dep_1"));

    await expect(first).resolves.toMatchObject({ sourceRevisionId: "src-dep_1" });
    await expect(second).resolves.toMatchObject({ sourceRevisionId: "src-dep_1" });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test("does not retain a null result", async () => {
    const lookup = vi
      .fn<(deploymentId: string) => Promise<EveVersionInfo | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(versionInfo("dep_1"));
    const cached = withDeploymentEveVersionCache({ getDeploymentEveVersion: lookup });

    await expect(cached.getDeploymentEveVersion("dep_1")).resolves.toBeNull();
    await expect(cached.getDeploymentEveVersion("dep_1")).resolves.toMatchObject({
      sourceRevisionId: "src-dep_1",
    });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test("does not retain a failed lookup", async () => {
    const lookup = vi
      .fn<(deploymentId: string) => Promise<EveVersionInfo | null>>()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue(versionInfo("dep_1"));
    const cached = withDeploymentEveVersionCache({ getDeploymentEveVersion: lookup });

    await expect(cached.getDeploymentEveVersion("dep_1")).rejects.toThrow("connection reset");
    await expect(cached.getDeploymentEveVersion("dep_1")).resolves.toMatchObject({
      sourceRevisionId: "src-dep_1",
    });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test("evicts the oldest entry past maxEntries", async () => {
    const lookup = vi.fn(async (deploymentId: string) => versionInfo(deploymentId));
    const cached = withDeploymentEveVersionCache(
      { getDeploymentEveVersion: lookup },
      { maxEntries: 2 },
    );

    await cached.getDeploymentEveVersion("dep_1");
    await cached.getDeploymentEveVersion("dep_2");
    await cached.getDeploymentEveVersion("dep_3");
    // dep_1 was evicted when dep_3 arrived; dep_2 and dep_3 are still cached.
    await cached.getDeploymentEveVersion("dep_2");
    await cached.getDeploymentEveVersion("dep_3");
    await cached.getDeploymentEveVersion("dep_1");

    expect(lookup.mock.calls.map(([deploymentId]) => deploymentId)).toEqual([
      "dep_1",
      "dep_2",
      "dep_3",
      "dep_1",
    ]);
  });

  test("passes every other repository member through unchanged", async () => {
    const repository = {
      getDeploymentEveVersion: vi.fn(async () => null),
      findRouteByHostname: vi.fn(async () => "route"),
      constant: 42,
    };
    const cached = withDeploymentEveVersionCache(repository);

    await expect(cached.findRouteByHostname()).resolves.toBe("route");
    expect(cached.constant).toBe(42);
  });
});
