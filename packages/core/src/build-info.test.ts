import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { EVELAND_VERSION } from "./build-info.js";

type BuildInfoModule = {
  createBuildInfo?: (
    component: "api" | "gateway" | "web" | "worker",
    input?: { revision?: string; channel?: string },
  ) => unknown;
  formatBuildInfo?: (buildInfo: {
    component: string;
    version: string;
    revision: string;
    channel: string;
  }) => string;
  isSameBuild?: (
    left: { version: string; revision: string; channel: string },
    right: { version: string; revision: string; channel: string },
  ) => boolean;
};

type ServerBuildInfoModule = {
  createBuildInfoFromEnv?: (
    component: "api" | "gateway" | "web" | "worker",
    environment: Record<string, string | undefined>,
  ) => unknown;
};

describe("Eveland build information", () => {
  test("identifies the product and the component that produced a build", async () => {
    const modulePath = "./build-info.js";
    const buildInfoModule = (await import(modulePath).catch(() => null)) as BuildInfoModule | null;

    expect(
      buildInfoModule?.createBuildInfo?.("api", {
        revision: "6bb1d53f51ab",
        channel: "stable",
      }),
    ).toEqual({
      service: "eveland",
      component: "api",
      version: EVELAND_VERSION,
      revision: "6bb1d53f51ab",
      channel: "stable",
    });
  });

  test("formats build identity consistently for component startup logs", async () => {
    const modulePath = "./build-info.js";
    const buildInfoModule = (await import(modulePath).catch(() => null)) as BuildInfoModule | null;
    const buildInfo = buildInfoModule?.createBuildInfo?.("gateway", {
      revision: "6bb1d53f51ab",
      channel: "stable",
    });

    expect(
      buildInfoModule?.formatBuildInfo?.(
        buildInfo as {
          component: string;
          version: string;
          revision: string;
          channel: string;
        },
      ),
    ).toBe(`Eveland ${EVELAND_VERSION} (gateway, stable, 6bb1d53f51ab)`);
  });

  test("detects components that were not deployed from the same build", async () => {
    const modulePath = "./build-info.js";
    const buildInfoModule = (await import(modulePath).catch(() => null)) as BuildInfoModule | null;
    const web = buildInfoModule?.createBuildInfo?.("web", {
      revision: "6bb1d53f51ab",
      channel: "stable",
    }) as { version: string; revision: string; channel: string };
    const api = buildInfoModule?.createBuildInfo?.("api", {
      revision: "6bb1d53f51ab",
      channel: "stable",
    }) as { version: string; revision: string; channel: string };

    expect(buildInfoModule?.isSameBuild?.(web, api)).toBe(true);
    expect(
      buildInfoModule?.isSameBuild?.(web, {
        ...api,
        revision: "different123",
      }),
    ).toBe(false);
  });

  test("reads revision and channel from the runtime environment with safe development defaults", async () => {
    const modulePath = "./server/build-info.js";
    const buildInfoModule = (await import(modulePath).catch(
      () => null,
    )) as ServerBuildInfoModule | null;

    expect(
      buildInfoModule?.createBuildInfoFromEnv?.("worker", {
        EVELAND_REVISION: "abc123def456",
        EVELAND_RELEASE_CHANNEL: "edge",
      }),
    ).toMatchObject({
      component: "worker",
      revision: "abc123def456",
      channel: "edge",
    });
    expect(buildInfoModule?.createBuildInfoFromEnv?.("web", {})).toMatchObject({
      component: "web",
      revision: "unknown",
      channel: "dev",
    });
  });

  test("keeps the product version and public build-info exports in sync", () => {
    const workspaceManifest = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const coreManifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, string> };

    expect(workspaceManifest.version).toBe(EVELAND_VERSION);
    expect(coreManifest.exports).toMatchObject({
      "./build-info": "./src/build-info.ts",
      "./server/build-info": "./src/server/build-info.ts",
    });
  });
});
