import { describe, expect, test } from "vitest";

describe("runtime deployment start spec", () => {
  test("selects adapter-visible directories and injects deployment identity", async () => {
    const runtimeJobs = await import("./process-runtime-job.js");

    expect(runtimeJobs).toHaveProperty("createDeploymentStartInput");
    const createDeploymentStartInput =
      runtimeJobs.createDeploymentStartInput!;
    const common = {
      processName: "eveland-agent",
      releaseRef: "eveland/project:release",
      port: 41_001,
      deploymentId: "dep_contract",
      env: { EXISTING: "value" },
      commandContext: { packageManager: "npm" as const, hasLockfile: false },
      sandboxCacheDirs: {
        workerDir: "/worker/sandbox",
        hostDir: "/host/sandbox",
      },
      observabilityPolicyDirs: {
        workerDir: "/worker/observability",
        hostDir: "/host/observability",
      },
    };

    expect(
      createDeploymentStartInput({ ...common, runtimeKind: "docker" }),
    ).toEqual({
      processName: common.processName,
      releaseRef: common.releaseRef,
      port: common.port,
      env: {
        EXISTING: "value",
        EVELAND_DEPLOYMENT_ID: common.deploymentId,
      },
      commandContext: common.commandContext,
      sandboxCacheDir: common.sandboxCacheDirs.hostDir,
      observabilityPolicyDir: common.observabilityPolicyDirs.hostDir,
    });
    expect(
      createDeploymentStartInput({ ...common, runtimeKind: "systemd" }),
    ).toMatchObject({
      sandboxCacheDir: common.sandboxCacheDirs.workerDir,
      observabilityPolicyDir: common.observabilityPolicyDirs.workerDir,
    });
  });
});
