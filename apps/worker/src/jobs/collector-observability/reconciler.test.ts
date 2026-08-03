import { createDefaultObservabilityPolicy } from "@eveland/core/observability";
import { DEFAULT_TEAM_ID } from "@eveland/db";
import { createTestStore } from "@eveland/db/vitest";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createCollectorObservabilityReconciler } from "./reconciler.js";
import {
  collectorAppSecretKey as appSecretKey,
  encryptedCollectorConfig as encrypted,
} from "./test-support.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("managed OpenTelemetry Collector reconciliation", () => {
  test("validates and applies a policy revision once without restarting Agents", async () => {
    const store = createTestStore();
    const dataDir = path.join(os.tmpdir(), `eveland-collector-policy-${Date.now()}`);
    temporaryDirectories.push(dataDir);
    const calls: string[] = [];
    const reconcile = createCollectorObservabilityReconciler({
      store,
      env: {
        APP_SECRET_KEY: appSecretKey,
        EVELAND_DATA_DIR: dataDir,
        EVELAND_HOST_DATA_DIR: dataDir,
      },
      validateConfig: async ({ workerPath }) => {
        calls.push(`validate:${workerPath}`);
        expect(await readFile(workerPath, "utf8")).toContain("otlp_http/builtin");
      },
      restartCollector: async () => {
        calls.push("restart");
      },
    });

    await expect(reconcile()).resolves.toBe(1);
    await expect(reconcile()).resolves.toBe(0);

    expect(calls).toEqual([
      `validate:${path.join(dataDir, "otel", "collector.yaml.candidate")}`,
      "restart",
    ]);
    await expect(readFile(path.join(dataDir, "otel", "collector.yaml"), "utf8")).resolves.toContain(
      "otlp_http/builtin",
    );
  });

  test.runIf(process.env.EVELAND_VALIDATE_OTEL_COLLECTOR === "1")(
    "passes the official Collector validation command",
    async () => {
      const store = createTestStore();
      await store.saveObservabilityPolicy({
        teamId: DEFAULT_TEAM_ID,
        expectedRevision: 1,
        agentCapture: createDefaultObservabilityPolicy(1).agentCapture,
        externalDestinations: [
          {
            id: "destination_validation",
            kind: "langfuse",
            enabled: true,
            securityRevision: 1,
            encryptedConfig: encrypted({
              kind: "langfuse",
              baseUrl: "https://langfuse.example.com",
              publicKey: "pk-lf-validation",
              secretKey: "sk-lf-validation",
            }),
            supportedSignals: ["traces"],
            filterProfile: "agent_genai",
          },
        ],
      });
      const dataDir = path.join(os.tmpdir(), `eveland-collector-validation-${Date.now()}`);
      temporaryDirectories.push(dataDir);
      const reconcile = createCollectorObservabilityReconciler({
        store,
        env: {
          APP_SECRET_KEY: appSecretKey,
          EVELAND_DATA_DIR: dataDir,
          EVELAND_HOST_DATA_DIR: dataDir,
        },
        restartCollector: async () => undefined,
      });

      await expect(reconcile()).resolves.toBe(1);
    },
  );
});
