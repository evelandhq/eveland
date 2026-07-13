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
      experimentId: null,
      requestId: "req_gateway",
      remoteIp: "203.0.113.20",
      affinityFingerprint: null,
      affinitySource: null,
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
      experimentId: `${stable!.id}:r1`,
      requestId: "req_gateway_playground",
      remoteIp: null,
      affinityFingerprint: null,
      affinitySource: null,
    });
    await expect(
      store.completeSession(playground.id, { status: "completed", eveSessionId: "eve_gateway_playground" }),
    ).resolves.toMatchObject({ routeId: stable!.id, experimentId: `${stable!.id}:r1`, trigger: "playground" });

    const candidate = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "gateway-candidate",
      containerName: `gateway-candidate-${Date.now()}`,
      internalPort: 3000,
      hostPort: 41997,
      runtimeKind: "docker",
    });
    await store.ensureDeploymentRoutes(project.id, candidate.id, "agent.localhost");
    const preview = (await store.listProjectRoutes(project.id)).find(
      (route) => route.kind === "deployment" && route.targets[0]?.deploymentId === deployment.id,
    );
    await expect(store.updateRouteTargets(preview!.id, [
      { deploymentId: candidate.id, weight: 10_000, variantName: "mutated-preview" },
    ])).rejects.toThrow(/preview.*immutable/i);
    await expect(store.findRouteByHostname(preview!.hostname)).resolves.toMatchObject({
      targets: [expect.objectContaining({ deploymentId: deployment.id, weight: 10_000 })],
    });
    await store.updateRouteTargets(stable!.id, [
      { deploymentId: deployment.id, weight: 9_000, variantName: "control" },
      { deploymentId: candidate.id, weight: 1_000, variantName: "candidate" },
    ]);
    await expect(store.findProjectRoute(project.id)).resolves.toMatchObject({ policyRevision: 2, targets: [
      expect.objectContaining({ deploymentId: deployment.id, weight: 9_000 }),
      expect.objectContaining({ deploymentId: candidate.id, weight: 1_000 }),
    ] });
    const experimentId = `${stable!.id}:r2`;
    await store.bindSession({
      projectId: project.id,
      eveSessionId: "eve_experiment_candidate",
      routeId: stable!.id,
      deploymentId: candidate.id,
      trigger: "api",
      variantName: "candidate",
      experimentId,
      requestId: "req_experiment_candidate",
      remoteIp: "203.0.113.21",
      affinityFingerprint: "sha256-experiment",
      affinitySource: "version_key",
    });
    await store.ingestObserverEnvelope(envelope(candidate.id, "eve_experiment_candidate", null, "experiment-candidate"));
    await expect(store.listSessions(project.id)).resolves.toContainEqual(expect.objectContaining({
      eveSessionId: "eve_experiment_candidate",
      deploymentId: candidate.id,
      experimentId,
      variantName: "candidate",
    }));
    await store.promoteDeployment(project.id, candidate.id);
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({ id: candidate.id });
    await expect(store.findRouteByHostname(`${deployment.deploymentKey}--${project.routingKey}.agent.localhost`)).resolves.toMatchObject({
      targets: [expect.objectContaining({ deploymentId: deployment.id })],
    });
    await store.promoteDeployment(project.id, deployment.id);
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({ id: deployment.id });
    await expect(store.findProjectRoute(project.id)).resolves.toMatchObject({
      targets: [expect.objectContaining({ deploymentId: deployment.id, weight: 10_000 })],
    });
    await expect(store.findRouteByHostname(`${candidate.deploymentKey}--${project.routingKey}.agent.localhost`)).resolves.toMatchObject({
      kind: "deployment",
      targets: [expect.objectContaining({ deploymentId: candidate.id, weight: 10_000 })],
    });
  }, 30_000);

  test("rolls back route target deletion when a later transaction step fails", async () => {
    const store = createPostgresStore(database!);
    const project = await store.createProject({ name: `Route rollback ${Date.now()}`, importKind: "zip" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/route-rollback",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "route-rollback",
      containerName: `route-rollback-${Date.now()}`,
      internalPort: 3000,
      hostPort: 41996,
      runtimeKind: "docker",
    });
    const [stable] = await store.ensureDeploymentRoutes(project.id, deployment.id, "agent.localhost");
    const before = await store.findProjectRoute(project.id);

    await database!.client.unsafe("DROP TRIGGER IF EXISTS eveland_test_reject_route_target ON route_targets");
    await database!.client.unsafe("DROP FUNCTION IF EXISTS eveland_test_reject_route_target() CASCADE");
    await database!.client.unsafe(`
      CREATE FUNCTION eveland_test_reject_route_target() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced route target failure'; END $$
    `);
    await database!.client.unsafe(`
      CREATE TRIGGER eveland_test_reject_route_target
      BEFORE INSERT ON route_targets
      FOR EACH ROW EXECUTE FUNCTION eveland_test_reject_route_target()
    `);
    try {
      await expect(store.updateRouteTargets(stable!.id, [
        { deploymentId: deployment.id, weight: 10_000, variantName: "control" },
      ])).rejects.toThrow(/insert into "route_targets"/);
    } finally {
      await database!.client.unsafe("DROP TRIGGER IF EXISTS eveland_test_reject_route_target ON route_targets");
      await database!.client.unsafe("DROP FUNCTION IF EXISTS eveland_test_reject_route_target() CASCADE");
    }

    await expect(store.findProjectRoute(project.id)).resolves.toEqual(before);
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
