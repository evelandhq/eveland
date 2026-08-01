import { describe, expect, test } from "vitest";

async function loadJobContracts() {
  const modulePath = "./jobs.js";
  return import(modulePath).catch(() => ({}));
}

describe("job payload contracts", () => {
  test("decodes every persisted job payload wire shape", async () => {
    const contracts = await loadJobContracts();
    expect(contracts).toHaveProperty("decodeJobPayload");
    const decodeJobPayload = contracts.decodeJobPayload!;

    expect(
      decodeJobPayload("import_source", {
        importKind: "git",
        gitUrl: "https://example.com/agent.git",
        sourcePath: null,
        deployAfterImport: true,
        promoteAfterDeploy: false,
        gitCredential: {
          userId: "user_1",
          host: "example.com",
          encryptedToken: "sealed",
          persistAfterImport: false,
        },
      }),
    ).toMatchObject({ importKind: "git", deployAfterImport: true });
    expect(
      decodeJobPayload("build_deploy", { promoteAfterDeploy: true }),
    ).toEqual({ promoteAfterDeploy: true });
    expect(
      decodeJobPayload("restart_deployment", {
        deploymentId: "dep_1",
        reason: "secret_changed",
      }),
    ).toEqual({ deploymentId: "dep_1", reason: "secret_changed" });
    expect(
      decodeJobPayload("trigger_schedule", { scheduleRunId: "run_1" }),
    ).toEqual({ scheduleRunId: "run_1" });
    expect(
      decodeJobPayload("ensure_deployment_running", {
        deploymentId: "dep_1",
        runtimeInstanceId: "rti_1",
      }),
    ).toEqual({ deploymentId: "dep_1", runtimeInstanceId: "rti_1" });
    expect(
      decodeJobPayload("archive_deployment", {
        deploymentId: "dep_1",
        automatic: true,
      }),
    ).toEqual({ deploymentId: "dep_1", automatic: true });
    expect(
      decodeJobPayload("delete_project", { sourcePaths: ["/managed/source"] }),
    ).toEqual({ sourcePaths: ["/managed/source"] });
  });

  test("rejects a payload that does not match its job type", async () => {
    const contracts = await loadJobContracts();
    expect(contracts).toHaveProperty("decodeJobPayload");
    const decodeJobPayload = contracts.decodeJobPayload!;

    expect(() => decodeJobPayload("trigger_schedule", {})).toThrow();
    expect(() =>
      decodeJobPayload("archive_deployment", { deploymentId: 42 }),
    ).toThrow();
    expect(() =>
      decodeJobPayload("delete_project", { sourcePaths: ["valid", 42] }),
    ).toThrow();
  });

  test("preserves legacy metadata while validating known payload fields", async () => {
    const contracts = await loadJobContracts();
    expect(contracts).toHaveProperty("decodeJobPayload");
    const decodeJobPayload = contracts.decodeJobPayload!;
    const payload = {
      deploymentId: "dep_legacy",
      reason: "operator_requested",
      legacyMetadata: { source: "pre-contract-worker" },
    };

    expect(decodeJobPayload("restart_deployment", payload)).toEqual(payload);
  });

  test("projects persisted jobs to a payload-free public status", async () => {
    const contracts = await loadJobContracts();
    expect(contracts).toHaveProperty("toPublicJob");

    const publicJob = contracts.toPublicJob!({
      id: "job_secret",
      projectId: "proj_1",
      type: "import_source",
      status: "queued",
      payload: {
        gitCredential: {
          userId: "user_1",
          host: "example.com",
          encryptedToken: "sealed-sensitive-value",
          persistAfterImport: false,
        },
      },
      attempts: 0,
      lastError: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(publicJob).toMatchObject({
      id: "job_secret",
      type: "import_source",
      payload: {},
    });
    expect(JSON.stringify(publicJob)).not.toContain("sealed-sensitive-value");
  });
});
