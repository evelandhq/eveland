import type { ObserverEnvelopeV1 } from "@eveland/core/observer";
import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.EVELAND_POSTGRES_TEST_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

describe.skipIf(!database)("Postgres Gateway routing", () => {
  test("materializes routes and merges a binding with child-first observer ingestion", async () => {
    const store = createPostgresStore(database!);
    const project = await store.createProject({ name: `Gateway integration ${Date.now()}`, importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/gateway-integration",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "gateway-integration",
      containerName: `gateway-integration-${Date.now()}`,
      internalPort: 3000,
      hostPort: 41998,
      runtimeKind: "docker",
    });
    const [stable] = await store.ensureDeploymentRoutes(project.id, deployment.id, "agent.localhost");
    await store.bindSession({
      projectId: project.id,
      eveSessionId: "eve_gateway_root",
      routeId: stable!.id,
      deploymentId: deployment.id,
      trigger: "api",
      variantName: null,
      requestId: "req_gateway",
      remoteIp: "203.0.113.20",
      affinityFingerprint: null,
    });

    await store.ingestObserverEnvelope(envelope(deployment.id, "eve_gateway_child", "eve_gateway_root", "child"));
    await store.ingestObserverEnvelope(envelope(deployment.id, "eve_gateway_root", null, "root"));

    await expect(store.findRouteByHostname(`${project.routingKey}.agent.localhost`)).resolves.toMatchObject({
      targets: [expect.objectContaining({ deploymentId: deployment.id, status: "running" })],
    });
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({ trigger: "api", routeId: stable!.id, deploymentId: deployment.id }),
    ]);
    const [session] = await store.listSessions(project.id);
    await expect(store.listSessionNodes(session!.id)).resolves.toHaveLength(2);

    const playground = await store.createSession({ projectId: project.id, deploymentId: deployment.id, trigger: "playground" });
    await store.bindSession({
      projectId: project.id,
      eveSessionId: "eve_gateway_playground",
      routeId: stable!.id,
      deploymentId: deployment.id,
      trigger: "playground",
      variantName: null,
      requestId: "req_gateway_playground",
      remoteIp: null,
      affinityFingerprint: null,
    });
    await expect(
      store.completeSession(playground.id, { status: "completed", eveSessionId: "eve_gateway_playground" }),
    ).resolves.toMatchObject({ routeId: stable!.id, trigger: "playground" });
  }, 30_000);
});

function envelope(deploymentId: string, eveSessionId: string, parentEveSessionId: string | null, name: string): ObserverEnvelopeV1 {
  return {
    schemaVersion: 1,
    observerEventId: `evt_${name}`,
    eventFingerprint: `fingerprint_${name}`,
    deploymentId,
    eveSessionId,
    parentEveSessionId,
    sourceSequence: 1,
    agent: { id: name, name, nodeId: name },
    channelKind: parentEveSessionId ? null : "http",
    eventAt: new Date().toISOString(),
    event: { type: "session.started", data: {} },
  };
}
