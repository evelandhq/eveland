import type { ObserverEnvelopeV1 } from "@eveland/core/observer";
import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./store.js";

describe("routing repository", () => {
  test("assigns DNS-safe immutable project and deployment keys and materializes stable/preview routes", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Gateway Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/gateway",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "gateway",
      containerName: "gateway",
      internalPort: 3000,
      hostPort: 41000,
      runtimeKind: "docker",
    });

    await store.ensureDeploymentRoutes(project.id, deployment.id, "agent.localhost");

    expect(project.routingKey).toMatch(/^p-[a-z0-9]+$/);
    expect(deployment.deploymentKey).toMatch(/^d-[a-z0-9]+$/);
    await expect(store.findRouteByHostname(`${project.routingKey}.agent.localhost`)).resolves.toMatchObject({
      kind: "project",
      targets: [expect.objectContaining({ deploymentId: deployment.id, weight: 10_000, status: "running" })],
    });
    await expect(
      store.findRouteByHostname(`${deployment.deploymentKey}--${project.routingKey}.agent.localhost`),
    ).resolves.toMatchObject({
      kind: "deployment",
      targets: [expect.objectContaining({ deploymentId: deployment.id, weight: 10_000 })],
    });
    await store.updateDeploymentStatus(deployment.id, "stopped");
    await expect(
      store.findRouteByHostname(`${deployment.deploymentKey}--${project.routingKey}.agent.localhost`),
    ).resolves.toMatchObject({ targets: [expect.objectContaining({ status: "stopped" })] });
    await store.reconcileAgentRoutes("agents.example.com");
    await expect(store.findRouteByHostname(`${project.routingKey}.agent.localhost`)).resolves.toBeNull();
    await expect(store.findRouteByHostname(`${project.routingKey}.agents.example.com`)).resolves.toMatchObject({ kind: "project" });
  });

  test("binding a Gateway session upgrades observer provenance without creating a duplicate root", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Bound Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/gateway",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "gateway",
      containerName: "gateway",
      internalPort: 3000,
      hostPort: 41000,
      runtimeKind: "docker",
    });
    const [route] = await store.ensureDeploymentRoutes(project.id, deployment.id, "agent.localhost");
    await store.ingestObserverEnvelope(envelope(deployment.id));

    await store.bindSession({
      projectId: project.id,
      eveSessionId: "eve_gateway",
      routeId: route!.id,
      deploymentId: deployment.id,
      trigger: "api",
      variantName: null,
      requestId: "req_1",
      remoteIp: "203.0.113.10",
      affinityFingerprint: null,
    });

    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({ trigger: "api", routeId: route!.id, deploymentId: deployment.id }),
    ]);
    await expect(store.findSessionBinding(project.id, "eve_gateway")).resolves.toMatchObject({ requestId: "req_1" });
  });

  test("applies a binding learned before the Playground session learns its Eve id", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Playground Binding", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/gateway",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "gateway",
      containerName: "gateway",
      internalPort: 3000,
      hostPort: 41000,
      runtimeKind: "docker",
    });
    const [route] = await store.ensureDeploymentRoutes(project.id, deployment.id, "agent.localhost");
    const session = await store.createSession({ projectId: project.id, deploymentId: deployment.id, trigger: "playground" });
    await store.bindSession({
      projectId: project.id,
      eveSessionId: "eve_playground",
      routeId: route!.id,
      deploymentId: deployment.id,
      trigger: "playground",
      variantName: null,
      requestId: "req_playground",
      remoteIp: null,
      affinityFingerprint: null,
    });

    const completed = await store.completeSession(session.id, { status: "completed", eveSessionId: "eve_playground" });

    expect(completed).toMatchObject({ trigger: "playground", routeId: route!.id, deploymentId: deployment.id });
  });
});

function envelope(deploymentId: string): ObserverEnvelopeV1 {
  return {
    schemaVersion: 1,
    observerEventId: "evt_gateway",
    eventFingerprint: "fingerprint_gateway",
    deploymentId,
    eveSessionId: "eve_gateway",
    parentEveSessionId: null,
    sourceSequence: 1,
    agent: { id: null, name: "root", nodeId: "root" },
    channelKind: "http",
    eventAt: new Date().toISOString(),
    event: { type: "session.started", data: {} },
  };
}
