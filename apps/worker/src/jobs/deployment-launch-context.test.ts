import {
  deriveAgentTelemetrySecret,
  verifyAgentTelemetryCredential,
} from "@evelandhq/core/server/agent-telemetry-credential";
import { encryptSecretValue } from "@evelandhq/core/server/secrets";
import { createTestStore } from "@evelandhq/db/vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { processSafeName } from "../runtime/types.js";
import {
  createDeploymentStartInput,
  ensureDeploymentLaunchSandbox,
  materializeDeploymentLaunchContext,
  resolveDeploymentLaunchPrerequisites,
  type DeploymentLaunchContext,
} from "./deployment-launch-context.js";

describe("deployment launch context", () => {
  test("resolves runtime inputs once and materializes adapter-visible directories", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "eveland-launch-context-"));
    const sourcePath = path.join(temporaryRoot, "source");
    const dataDir = path.join(temporaryRoot, "worker-data");
    const hostDataDir = path.join(temporaryRoot, "host-data");
    const appSecretKey = "12345678901234567890123456789012";
    const store = createTestStore();

    try {
      await mkdir(sourcePath, { recursive: true });
      await writeFile(
        path.join(sourcePath, "package.json"),
        JSON.stringify({ dependencies: { eve: "^0.47.7" } }),
      );
      await writeFile(path.join(sourcePath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const project = await store.createProject({
        name: "Launch Context",
        importKind: "zip",
        sourcePath,
      });
      await store.upsertSecret(
        project.id,
        "PROJECT_TOKEN",
        JSON.stringify(encryptSecretValue("project-value", appSecretKey)),
      );
      await store.saveSharedAgentEnvironment({
        entries: [
          {
            key: "SHARED_TOKEN",
            kind: "secret",
            encryptedValue: JSON.stringify(encryptSecretValue("shared-value", appSecretKey)),
          },
        ],
      });
      const workerEnv = {
        EVELAND_DATA_DIR: dataDir,
        EVELAND_HOST_DATA_DIR: hostDataDir,
        APP_SECRET_KEY: "abcdefghijklmnopqrstuvwxyz123456",
        NODE_ENV: "development",
      } satisfies NodeJS.ProcessEnv;
      const options = {
        appSecretKey,
        nodeEnv: "development",
        workflowPostgresUrl: "",
      };

      const prerequisites = await resolveDeploymentLaunchPrerequisites({
        store,
        workerEnv,
        projectId: project.id,
        deploymentId: "dep_launch_context",
        runtimeKind: "docker",
        sourcePath,
        options,
      });

      expect(prerequisites).toMatchObject({
        env: {
          PROJECT_TOKEN: "project-value",
          SHARED_TOKEN: "shared-value",
          EVELAND_PROJECT_ID: project.id,
          // Docker deployments read their memory root at the fixed in-container
          // mount path; the host directory is what the adapter mounts there.
          EVELAND_MEMORY_ROOT: "/var/lib/eveland-memory",
        },
        secretValues: expect.arrayContaining(["project-value", "shared-value"]),
        commandContext: { packageManager: "pnpm", hasLockfile: true },
      });
      await expect(
        resolveDeploymentLaunchPrerequisites({
          store,
          workerEnv: { ...workerEnv, APP_SECRET_KEY: appSecretKey },
          projectId: project.id,
          deploymentId: "dep_worker_env_fallback",
          runtimeKind: "docker",
          sourcePath,
          options: {
            nodeEnv: "development",
            workflowPostgresUrl: "",
          },
        }),
      ).resolves.toMatchObject({
        env: {
          PROJECT_TOKEN: "project-value",
          SHARED_TOKEN: "shared-value",
        },
      });

      await ensureDeploymentLaunchSandbox(prerequisites);
      const context = await materializeDeploymentLaunchContext({
        store,
        releaseId: "rel_launch_context",
        prerequisites,
      });
      const safeProjectId = processSafeName(project.id);

      expect(context).toMatchObject({
        deploymentId: "dep_launch_context",
        runtimeKind: "docker",
        env: prerequisites.env,
        secretValues: prerequisites.secretValues,
        commandContext: prerequisites.commandContext,
        sandboxCacheDirs: {
          workerDir: path.join(dataDir, "sandbox", safeProjectId),
          hostDir: path.join(hostDataDir, "sandbox", safeProjectId),
        },
        memoryRootDirs: {
          workerDir: path.join(dataDir, "memory", safeProjectId),
          hostDir: path.join(hostDataDir, "memory", safeProjectId),
        },
        observabilityPolicyDirs: {
          workerDir: path.join(dataDir, "observability", safeProjectId, "dep_launch_context"),
          hostDir: path.join(hostDataDir, "observability", safeProjectId, "dep_launch_context"),
        },
      });
      expect(context).not.toHaveProperty("observability");
      await expect(
        stat(context.sandboxCacheDirs.workerDir).then((entry) => entry.isDirectory()),
      ).resolves.toBe(true);
      await expect(
        stat(context.memoryRootDirs.workerDir).then((entry) => entry.isDirectory()),
      ).resolves.toBe(true);
      const policy = JSON.parse(
        await readFile(
          path.join(context.observabilityPolicyDirs.workerDir, "agent-policy.json"),
          "utf8",
        ),
      ) as { deploymentCredential: string };
      expect(
        verifyAgentTelemetryCredential(
          policy.deploymentCredential,
          deriveAgentTelemetrySecret(appSecretKey),
        ),
      ).toMatchObject({ deploymentId: "dep_launch_context" });
      expect(
        verifyAgentTelemetryCredential(
          policy.deploymentCredential,
          deriveAgentTelemetrySecret(workerEnv.APP_SECRET_KEY),
        ),
      ).toBeNull();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("hands each adapter its own visible side of the per-project directories", () => {
    const launchContext = (runtimeKind: "docker" | "systemd"): DeploymentLaunchContext => ({
      deploymentId: "dep_sides",
      runtimeKind,
      env: { EVELAND_MEMORY_ROOT: "/from-compose" },
      secretValues: [],
      commandContext: { hasLockfile: false },
      sandboxCacheDirs: { workerDir: "/worker/sandbox/p", hostDir: "/host/sandbox/p" },
      memoryRootDirs: { workerDir: "/worker/memory/p", hostDir: "/host/memory/p" },
      observabilityPolicyDirs: { workerDir: "/worker/obs/p/d", hostDir: "/host/obs/p/d" },
    });

    const docker = createDeploymentStartInput({
      processName: "eveland-p-d",
      releaseRef: "eveland/p:rel",
      port: 43000,
      launchContext: launchContext("docker"),
    });
    expect(docker.sandboxCacheDir).toBe("/host/sandbox/p");
    expect(docker.memoryRootDir).toBe("/host/memory/p");

    const systemd = createDeploymentStartInput({
      processName: "eveland-p-d",
      releaseRef: "/worker/builds/p/rel",
      port: 43000,
      launchContext: launchContext("systemd"),
    });
    expect(systemd.sandboxCacheDir).toBe("/worker/sandbox/p");
    expect(systemd.memoryRootDir).toBe("/worker/memory/p");
  });
});
