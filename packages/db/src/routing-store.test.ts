import type { ObserverEnvelopeV1 } from "@eveland/core/observer";
import type { DeploymentRecord } from "@eveland/core/contracts";
import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

describe("routing repository", () => {
  test("normalizes project names and atomically claims deterministic duplicate suffixes", async () => {
    const store = createTestStore();

    const first = await store.createProject({ name: "Sample Office Assistant", importKind: "git" });
    const second = await store.createProject({ name: "sample-office-assistant", importKind: "git" });

    expect(first).toMatchObject({ name: "sample-office-assistant", slug: "sample-office-assistant" });
    expect(second).toMatchObject({ name: "sample-office-assistant-1", slug: "sample-office-assistant-1" });
  });

  test("keeps concurrent deployments, atomically promotes and splits stable traffic, and preserves previews", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Concurrent Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id, kind: "zip", sourcePath: "/tmp/concurrent", summary: {}, envVars: [], files: [], schedules: [],
    });
    const first = await store.recordDeployment({
      projectId: project.id, sourceRevisionId: revision.id, imageTag: "first", containerName: "first", internalPort: 3000, hostPort: 41001, runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(project.id, first.id, "agent.localhost");
    const second = await store.recordDeployment({
      projectId: project.id, sourceRevisionId: revision.id, imageTag: "second", containerName: "second", internalPort: 3000, hostPort: 41002, runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(project.id, second.id, "agent.localhost");

    expect(await store.listDeployments(project.id)).toHaveLength(2);
    const preview = (await store.listProjectRoutes(project.id)).find(
      (route) => route.kind === "deployment" && route.targets[0]?.deploymentId === first.id,
    );
    await expect(store.updateRouteTargets(preview!.id, [
      { deploymentId: second.id, weight: 10_000, variantName: "mutated-preview" },
    ])).rejects.toThrow(/preview.*immutable/i);
    await expect(store.findRouteByHostname(preview!.hostname)).resolves.toMatchObject({
      targets: [expect.objectContaining({ deploymentId: first.id, weight: 10_000 })],
    });
    const stable = await store.findProjectRoute(project.id);
    expect(stable?.targets).toEqual([expect.objectContaining({ deploymentId: first.id, weight: 10_000 })]);
    await store.updateRouteTargets(stable!.id, [
      { deploymentId: first.id, weight: 9_000, variantName: "control" },
      { deploymentId: second.id, weight: 1_000, variantName: "candidate" },
    ]);
    await expect(store.findProjectRoute(project.id)).resolves.toMatchObject({
      policyRevision: 2,
      targets: [
        expect.objectContaining({ deploymentId: first.id, weight: 9_000 }),
        expect.objectContaining({ deploymentId: second.id, weight: 1_000 }),
      ],
    });
    await store.promoteDeployment(project.id, second.id);
    await expect(store.findProjectRoute(project.id)).resolves.toMatchObject({
      policyRevision: 3,
      targets: [expect.objectContaining({ deploymentId: second.id, weight: 10_000 })],
    });
    await expect(store.findRouteByHostname(`${first.deploymentKey}--${project.slug}.agent.localhost`)).resolves.toMatchObject({
      targets: [expect.objectContaining({ deploymentId: first.id })],
    });
  });

  test("reserves host ports until their Deployment is archived", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Port Reservation Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id, kind: "zip", sourcePath: "/tmp/port-reservation", summary: {}, envVars: [], files: [], schedules: [],
    });
    const retained = await store.recordDeployment({
      projectId: project.id, sourceRevisionId: revision.id, imageTag: "retained", containerName: "retained", internalPort: 3000,
      hostPort: 41090, runtimeKind: "docker",
    });
    const archived = await store.recordDeployment({
      projectId: project.id, sourceRevisionId: revision.id, imageTag: "archived", containerName: "archived", internalPort: 3000,
      hostPort: 41091, runtimeKind: "docker",
    });
    await store.updateDeploymentStatus(retained.id, "stopped");
    await store.updateDeploymentStatus(archived.id, "archived");

    await expect(store.listReservedDeploymentHostPorts()).resolves.toContain(41090);
    await expect(store.listReservedDeploymentHostPorts()).resolves.not.toContain(41091);
  });

  test("creates named aliases and reports retention protection from routes and active sessions", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Retention Agent", importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id, kind: "zip", sourcePath: "/tmp/retention", summary: {}, envVars: [], files: [], schedules: [],
    });
    const deployments: DeploymentRecord[] = [];
    for (let index = 0; index < 4; index += 1) {
      deployments.push(await store.recordDeployment({
        projectId: project.id, sourceRevisionId: revision.id, imageTag: `v${index}`, containerName: `v${index}`, internalPort: 3000,
        hostPort: 41100 + index, runtimeKind: "docker",
      }));
    }
    await store.ensureDeploymentRoutes(project.id, deployments[3]!.id, "agent.localhost");
    const alias = await store.ensureAliasRoute(project.id, "canary", "agent.localhost", [
      { deploymentId: deployments[2]!.id, weight: 10_000, variantName: "canary" },
    ]);
    expect(alias.hostname).toBe(`canary--${project.slug}.agent.localhost`);
    const policy = await store.getDeploymentRetention(project.id, 3);
    expect(policy.find((entry) => entry.deployment.id === deployments[0]!.id)).toMatchObject({ protected: false });
    expect(policy.find((entry) => entry.deployment.id === deployments[2]!.id)).toMatchObject({ protected: true, reasons: expect.arrayContaining(["route_target", "recent_artifact"]) });
  });

  test("assigns a semantic project slug and short deployment key and materializes stable/preview routes", async () => {
    const store = createTestStore();
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

    expect(project).toMatchObject({ name: "gateway-agent", slug: "gateway-agent" });
    expect(deployment.deploymentKey).toMatch(/^[a-z0-9]{8}$/);
    await expect(store.findRouteByHostname(`${project.slug}.agent.localhost`)).resolves.toMatchObject({
      kind: "project",
      targets: [expect.objectContaining({ deploymentId: deployment.id, weight: 10_000, status: "running" })],
    });
    await expect(
      store.findRouteByHostname(`${deployment.deploymentKey}--${project.slug}.agent.localhost`),
    ).resolves.toMatchObject({
      kind: "deployment",
      targets: [expect.objectContaining({ deploymentId: deployment.id, weight: 10_000 })],
    });
    await store.updateDeploymentStatus(deployment.id, "stopped");
    await expect(
      store.findRouteByHostname(`${deployment.deploymentKey}--${project.slug}.agent.localhost`),
    ).resolves.toMatchObject({ targets: [expect.objectContaining({ status: "stopped" })] });
    await store.reconcileAgentRoutes("agents.example.com");
    await expect(store.findRouteByHostname(`${project.slug}.agent.localhost`)).resolves.toBeNull();
    await expect(store.findRouteByHostname(`${project.slug}.agents.example.com`)).resolves.toMatchObject({ kind: "project" });
  });

  test("binding a Gateway session upgrades observer provenance without creating a duplicate root", async () => {
    const store = createTestStore();
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
      experimentId: null,
      requestId: "req_1",
      remoteIp: "203.0.113.10",
      affinityFingerprint: null,
      affinitySource: null,
    });

    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({ trigger: "api", routeId: route!.id, deploymentId: deployment.id }),
    ]);
    await expect(store.findSessionBinding(project.id, "eve_gateway")).resolves.toMatchObject({ requestId: "req_1" });
  });

  test("applies a binding learned before the Playground session learns its Eve id", async () => {
    const store = createTestStore();
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
      experimentId: `${route!.id}:r1`,
      requestId: "req_playground",
      remoteIp: null,
      affinityFingerprint: null,
      affinitySource: null,
    });

    const completed = await store.completeSession(session.id, { status: "completed", eveSessionId: "eve_playground" });

    expect(completed).toMatchObject({
      trigger: "playground",
      routeId: route!.id,
      deploymentId: deployment.id,
      experimentId: `${route!.id}:r1`,
    });
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
