import {
  hashModelGatewayToken,
  mintModelGatewayToken,
} from "@evelandhq/core/server/model-gateway-token";
import { createTestStore } from "@evelandhq/db/vitest";
import { expect, test } from "vitest";
import { createInstanceTokenAuthenticator } from "./instance-token-auth.js";

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

  expect(await authenticate(token)).toBe(true);

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
