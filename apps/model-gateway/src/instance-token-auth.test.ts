import {
  hashModelGatewayToken,
  mintModelGatewayToken,
} from "@evelandhq/core/server/model-gateway-token";
import { createTestStore } from "@evelandhq/db/vitest";
import { expect, test } from "vitest";
import {
  createInstanceTokenAuthenticator,
  createModelGatewayAuthenticator,
} from "./instance-token-auth.js";

async function startInstanceWithToken(store: ReturnType<typeof createTestStore>) {
  const project = await store.createProject({ name: "MG Auth Agent", importKind: "zip" });
  const importJob = await store.claimNextJob("fixture-import");
  await store.completeJob(importJob!.id);
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "zip",
    sourcePath: "/tmp/mg-auth",
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  const deployment = await store.recordDeployment({
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: "fixture:mg-auth",
    containerName: "fixture-mg-auth",
    internalPort: 3000,
    hostPort: 42201,
    runtimeKind: "docker",
  });
  const token = mintModelGatewayToken();
  const instance = await store.adoptRuntimeInstance(
    deployment.id,
    { endpointHost: "127.0.0.1", endpointPort: deployment.hostPort },
    undefined,
    { modelGatewayTokenHash: hashModelGatewayToken(token) },
  );
  return { token, instance: instance!, store };
}

test("accepts a live instance token and rejects it after the instance stops", async () => {
  const store = createTestStore();
  const { token, instance } = await startInstanceWithToken(store);
  const authenticate = createInstanceTokenAuthenticator(store);

  await expect(authenticate(token)).resolves.toEqual({
    subject: `project:${(await store.findLiveRuntimeInstanceByModelGatewayTokenHash(hashModelGatewayToken(token)))!.projectId}`,
  });

  await store.updateRuntimeInstance(instance.id, {
    status: "stopped",
    endpointHost: null,
    endpointPort: null,
  });
  expect(await authenticate(token)).toBe(false);
});

test("rejects unknown and malformed tokens", async () => {
  const store = createTestStore();
  await startInstanceWithToken(store);
  const authenticate = createInstanceTokenAuthenticator(store);

  expect(await authenticate(mintModelGatewayToken())).toBe(false);
  expect(await authenticate("")).toBe(false);
  expect(await authenticate("not-a-token")).toBe(false);
});

test("personal API keys authenticate until revoked, alongside instance tokens", async () => {
  const store = createTestStore();
  const { token: instanceToken } = await startInstanceWithToken(store);
  const personalToken = `emk_${"k".repeat(43)}`;
  const key = await store.mintModelGatewayApiKey({
    userId: "user_a",
    name: "local dev",
    tokenHash: hashModelGatewayToken(personalToken),
  });
  const authenticate = createModelGatewayAuthenticator(store);

  expect(await authenticate(instanceToken)).toMatchObject({
    subject: expect.stringMatching(/^project:proj_/),
  });
  expect(await authenticate(personalToken)).toEqual({ subject: "user:user_a" });
  expect(await authenticate(`emk_${"x".repeat(43)}`)).toBe(false);
  expect(await authenticate("weird-prefix-token")).toBe(false);

  await store.revokeModelGatewayApiKey(key.id);
  expect(await authenticate(personalToken)).toBe(false);
  expect(await authenticate(instanceToken)).toMatchObject({
    subject: expect.stringMatching(/^project:proj_/),
  });
});
