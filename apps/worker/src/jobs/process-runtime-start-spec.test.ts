import { describe, expect, test } from "vitest";

import { createDeploymentStartInput } from "./deployment-launch-context.js";

describe("runtime deployment start spec", () => {
  test("selects adapter-visible directories and injects deployment identity", () => {
    const common = {
      processName: "eveland-agent",
      releaseRef: "eveland/project:release",
      port: 41_001,
      launchContext: {
        deploymentId: "dep_contract",
        env: { EXISTING: "value" },
        secretValues: ["masked-value"],
        commandContext: {
          packageManager: "npm" as const,
          hasLockfile: false,
        },
        sandboxCacheDirs: {
          workerDir: "/worker/sandbox",
          hostDir: "/host/sandbox",
        },
        observabilityPolicyDirs: {
          workerDir: "/worker/observability",
          hostDir: "/host/observability",
        },
      },
    };

    expect(
      createDeploymentStartInput({
        ...common,
        launchContext: { ...common.launchContext, runtimeKind: "docker" },
      }),
    ).toEqual({
      processName: common.processName,
      releaseRef: common.releaseRef,
      port: common.port,
      env: {
        EXISTING: "value",
        EVELAND_DEPLOYMENT_ID: common.launchContext.deploymentId,
      },
      commandContext: common.launchContext.commandContext,
      sandboxCacheDir: common.launchContext.sandboxCacheDirs.hostDir,
      observabilityPolicyDir:
        common.launchContext.observabilityPolicyDirs.hostDir,
    });
    expect(
      createDeploymentStartInput({
        ...common,
        launchContext: { ...common.launchContext, runtimeKind: "systemd" },
      }),
    ).toEqual({
      processName: common.processName,
      releaseRef: common.releaseRef,
      port: common.port,
      env: {
        EXISTING: "value",
        EVELAND_DEPLOYMENT_ID: common.launchContext.deploymentId,
      },
      commandContext: common.launchContext.commandContext,
      sandboxCacheDir: common.launchContext.sandboxCacheDirs.workerDir,
      observabilityPolicyDir:
        common.launchContext.observabilityPolicyDirs.workerDir,
    });
  });
});
