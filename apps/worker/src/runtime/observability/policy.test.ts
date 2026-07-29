import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  AGENT_OBSERVABILITY_MOUNT_DIR,
  writeAgentRuntimePolicy,
} from "./policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent runtime observability policy delivery", () => {
  test("atomically writes a validated revision without deployment environment variables", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "eveland-observability-policy-"),
    );
    temporaryDirectories.push(directory);

    const firstPath = await writeAgentRuntimePolicy({
      directory,
      policy: policy(1, false),
    });
    const secondPath = await writeAgentRuntimePolicy({
      directory,
      policy: policy(2, true),
    });

    expect(firstPath).toBe(path.join(directory, "agent-policy.json"));
    expect(secondPath).toBe(firstPath);
    expect(JSON.parse(await readFile(secondPath, "utf8"))).toMatchObject({
      revision: 2,
      capture: { enabled: true },
    });
    expect(await readdir(directory)).toEqual(["agent-policy.json"]);
    expect((await stat(directory)).mode & 0o7777).toBe(0o2750);
    expect((await stat(secondPath)).mode & 0o777).toBe(0o640);
    expect(AGENT_OBSERVABILITY_MOUNT_DIR).toBe(
      "/run/eveland/observability",
    );
  });

  test("rejects an Agent-visible endpoint containing credentials", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "eveland-observability-policy-"),
    );
    temporaryDirectories.push(directory);

    await expect(
      writeAgentRuntimePolicy({
        directory,
        policy: {
          ...policy(1, true),
          otlp: {
            endpoint: "http://collector:secret@127.0.0.1:4318",
          },
        },
      }),
    ).rejects.toThrow(/credentials/);
    expect(await readdir(directory)).toEqual([]);
  });
});

function policy(revision: number, enabled: boolean) {
  return {
    schemaVersion: 1 as const,
    revision,
    capture: {
      enabled,
      sampleRatio: 1,
      recordInputs: false,
      recordOutputs: false,
      includeReasoning: false,
    },
    otlp: {
      endpoint: "http://127.0.0.1:4318",
    },
    deploymentCredential: "credential.signature",
    resource: {
      teamId: "team_1",
      projectId: "proj_1",
      releaseId: "rel_1",
      deploymentId: "dep_1",
      runtimeKind: "systemd" as const,
      environment: "production",
    },
  };
}
