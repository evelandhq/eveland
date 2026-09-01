import type { AgentEventObservation } from "@evelandhq/core/observability";
import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";
import { resolvePostgresTestUrl } from "./postgres-integration.test-support.js";

const databaseUrl = resolvePostgresTestUrl();
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

describe.skipIf(!database)("Postgres Gateway routing", () => {
  test("keeps the first OperationBinding winner under concurrent claims", async () => {
    const store = createPostgresStore(database!);
    const nonce = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
    const project = await store.createProject({
      name: `Operation claim ${nonce}`,
      importKind: "zip",
    });
    try {
      const revision = await store.recordSourceRevision({
        projectId: project.id,
        kind: "zip",
        sourcePath: "/tmp/postgres-operation-claim",
        summary: {},
        envVars: [],
        files: [],
        schedules: [],
      });
      const first = await store.recordDeployment({
        projectId: project.id,
        sourceRevisionId: revision.id,
        imageTag: `operation-first-${nonce}`,
        containerName: `operation-first-${nonce}`,
        internalPort: 3000,
        hostPort: 42_100 + Math.floor(Math.random() * 500),
        runtimeKind: "docker",
      });
      const second = await store.recordDeployment({
        projectId: project.id,
        sourceRevisionId: revision.id,
        imageTag: `operation-second-${nonce}`,
        containerName: `operation-second-${nonce}`,
        internalPort: 3000,
        hostPort: 42_600 + Math.floor(Math.random() * 500),
        runtimeKind: "docker",
      });
      const [stable] = await store.ensureDeploymentRoutes(project.id, first.id, "agent.localhost");
      await store.ensureDeploymentRoutes(project.id, second.id, "agent.localhost");
      const operationKey = `hmac-sha256-${nonce}`;

      const claims = await Promise.all(
        [first, second].map((deployment) =>
          store.bindOperation({
            projectId: project.id,
            operationKey,
            routeId: stable!.id,
            deploymentId: deployment.id,
            trigger: "api",
            variantName: deployment.id,
            experimentId: null,
          }),
        ),
      );

      expect(new Set(claims.map((claim) => claim.id)).size).toBe(1);
      expect(new Set(claims.map((claim) => claim.deploymentId)).size).toBe(1);
    } finally {
      await store.deleteProject(project.id);
    }
  }, 30_000);

  test("atomically claims semantic project slugs and eight-character deployment keys", async () => {
    const store = createPostgresStore(database!);
    const requestedName = `postgres-slug-${Date.now()}`;
    const first = await store.createProject({ name: requestedName, importKind: "zip" });
    const second = await store.createProject({ name: requestedName, importKind: "zip" });
    await expect(store.isProjectSlugAvailable(requestedName)).resolves.toBe(false);
    await expect(
      store.createProject({
        name: requestedName,
        importKind: "zip",
        requireExactSlug: true,
      }),
    ).rejects.toThrow("Project name is already in use.");
    const revision = await store.recordSourceRevision({
      projectId: first.id,
      kind: "zip",
      sourcePath: "/tmp/postgres-slug",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const deployment = await store.recordDeployment({
      projectId: first.id,
      sourceRevisionId: revision.id,
      imageTag: "postgres-slug",
      containerName: `postgres-slug-${Date.now()}`,
      internalPort: 3000,
      hostPort: 41995,
      runtimeKind: "docker",
    });

    expect(first).toMatchObject({ name: requestedName, slug: requestedName });
    expect(second).toMatchObject({ name: `${requestedName}-1`, slug: `${requestedName}-1` });
    expect(deployment.deploymentKey).toMatch(/^[a-z0-9]{8}$/);
    await store.ensureDeploymentRoutes(first.id, deployment.id, "agent.localhost");
    await expect(
      store.findRouteByHostname(`${deployment.deploymentKey}--${first.slug}.agent.localhost`),
    ).resolves.toMatchObject({
      kind: "deployment",
      targets: [expect.objectContaining({ deploymentId: deployment.id })],
    });
  }, 30_000);

  test("materializes routes and merges a binding with child-first telemetry ingestion", async () => {
    const store = createPostgresStore(database!);
    const project = await store.createProject({
      name: `Gateway integration ${Date.now()}`,
      importKind: "zip",
    });
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
    const [stable] = await store.ensureDeploymentRoutes(
      project.id,
      deployment.id,
      "agent.localhost",
    );
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

    await store.ingestAgentEvent(
      envelope(deployment.id, "eve_gateway_child", "eve_gateway_root", "child"),
    );
    await store.ingestAgentEvent(envelope(deployment.id, "eve_gateway_root", null, "root"));

    await expect(
      store.findRouteByHostname(`${project.slug}.agent.localhost`),
    ).resolves.toMatchObject({
      targets: [expect.objectContaining({ deploymentId: deployment.id, status: "running" })],
    });
    await expect(store.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({ trigger: "api", routeId: stable!.id, deploymentId: deployment.id }),
    ]);
    const [session] = await store.listSessions(project.id);
    await expect(store.listSessionNodes(session!.id)).resolves.toHaveLength(2);

    const playground = await store.createSession({
      projectId: project.id,
      deploymentId: deployment.id,
      trigger: "playground",
    });
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
      store.completeSession(playground.id, {
        status: "waiting_approval",
        eveSessionId: "eve_gateway_playground",
      }),
    ).resolves.toMatchObject({
      routeId: stable!.id,
      experimentId: `${stable!.id}:r1`,
      trigger: "playground",
      status: "waiting_approval",
      completedAt: null,
    });
    await expect(
      store.getSessionByEveSessionId(project.id, "eve_gateway_playground"),
    ).resolves.toMatchObject({ id: playground.id });
    await expect(
      store.completeSession(playground.id, {
        status: "completed",
        eveSessionId: "eve_gateway_playground",
      }),
    ).resolves.toMatchObject({ status: "completed", completedAt: expect.any(String) });

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
    await expect(
      store.updateRouteTargets(preview!.id, [
        { deploymentId: candidate.id, weight: 10_000, variantName: "mutated-preview" },
      ]),
    ).rejects.toThrow(/preview.*immutable/i);
    await expect(store.findRouteByHostname(preview!.hostname)).resolves.toMatchObject({
      targets: [expect.objectContaining({ deploymentId: deployment.id, weight: 10_000 })],
    });
    await store.updateRouteTargets(stable!.id, [
      { deploymentId: deployment.id, weight: 9_000, variantName: "control" },
      { deploymentId: candidate.id, weight: 1_000, variantName: "candidate" },
    ]);
    await expect(store.findProjectRoute(project.id)).resolves.toMatchObject({
      policyRevision: 2,
      targets: [
        expect.objectContaining({ deploymentId: deployment.id, weight: 9_000 }),
        expect.objectContaining({ deploymentId: candidate.id, weight: 1_000 }),
      ],
    });
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
    await store.ingestAgentEvent(
      envelope(candidate.id, "eve_experiment_candidate", null, "experiment-candidate"),
    );
    await expect(store.listSessions(project.id)).resolves.toContainEqual(
      expect.objectContaining({
        eveSessionId: "eve_experiment_candidate",
        deploymentId: candidate.id,
        experimentId,
        variantName: "candidate",
      }),
    );
    await store.promoteDeployment(project.id, candidate.id);
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({
      id: candidate.id,
    });
    await expect(
      store.findRouteByHostname(`${deployment.deploymentKey}--${project.slug}.agent.localhost`),
    ).resolves.toMatchObject({
      targets: [expect.objectContaining({ deploymentId: deployment.id })],
    });
    await store.promoteDeployment(project.id, deployment.id);
    await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({
      id: deployment.id,
    });
    await expect(store.findProjectRoute(project.id)).resolves.toMatchObject({
      targets: [expect.objectContaining({ deploymentId: deployment.id, weight: 10_000 })],
    });
    await expect(
      store.findRouteByHostname(`${candidate.deploymentKey}--${project.slug}.agent.localhost`),
    ).resolves.toMatchObject({
      kind: "deployment",
      targets: [expect.objectContaining({ deploymentId: candidate.id, weight: 10_000 })],
    });
  }, 30_000);

  test("rolls back route target deletion when a later transaction step fails", async () => {
    const store = createPostgresStore(database!);
    const project = await store.createProject({
      name: `Route rollback ${Date.now()}`,
      importKind: "zip",
    });
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
    const [stable] = await store.ensureDeploymentRoutes(
      project.id,
      deployment.id,
      "agent.localhost",
    );
    const before = await store.findProjectRoute(project.id);

    await database!.client.unsafe(
      "DROP TRIGGER IF EXISTS eveland_test_reject_route_target ON route_targets",
    );
    await database!.client.unsafe(
      "DROP FUNCTION IF EXISTS eveland_test_reject_route_target() CASCADE",
    );
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
      await expect(
        store.updateRouteTargets(stable!.id, [
          { deploymentId: deployment.id, weight: 10_000, variantName: "control" },
        ]),
      ).rejects.toThrow(/insert into "route_targets"/);
    } finally {
      await database!.client.unsafe(
        "DROP TRIGGER IF EXISTS eveland_test_reject_route_target ON route_targets",
      );
      await database!.client.unsafe(
        "DROP FUNCTION IF EXISTS eveland_test_reject_route_target() CASCADE",
      );
    }

    await expect(store.findProjectRoute(project.id)).resolves.toEqual(before);
  }, 30_000);
});

function envelope(
  deploymentId: string,
  eveSessionId: string,
  parentEveSessionId: string | null,
  name: string,
): AgentEventObservation {
  return {
    telemetryEventId: `evt_${name}`,
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

describe.skipIf(!database)("Postgres deployment recording atomicity", () => {
  test("a failed deployment insert leaves no orphan release behind", async () => {
    const store = createPostgresStore(database!);
    const project = await store.createProject({
      name: `atomic-deploy-${Date.now()}`,
      importKind: "zip",
    });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "zip",
      sourcePath: "/tmp/atomic-deploy-pg",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    const first = await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "atomic-pg:one",
      containerName: "atomic-pg-one",
      internalPort: 3000,
      hostPort: 41883,
      runtimeKind: "docker",
    });

    try {
      await expect(
        store.recordDeployment({
          deploymentId: first.id,
          projectId: project.id,
          sourceRevisionId: revision.id,
          imageTag: "atomic-pg:two",
          containerName: "atomic-pg-two",
          internalPort: 3000,
          hostPort: 41884,
          runtimeKind: "docker",
        }),
      ).rejects.toThrow();

      const releases = Object.keys(await store.listReleaseSummaries(project.id));
      expect(releases).toEqual([first.releaseId]);
      await expect(store.listDeployments(project.id)).resolves.toHaveLength(1);
    } finally {
      await store.deleteProject(project.id);
    }
  });
});
