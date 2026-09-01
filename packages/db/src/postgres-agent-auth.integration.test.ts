import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";
import { resolvePostgresTestUrl } from "./postgres-integration.test-support.js";

const databaseUrl = resolvePostgresTestUrl();
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

describe.skipIf(!database)("Postgres Agent Auth", () => {
  test("fences revisions and credential rotation across two store instances", async () => {
    const firstStore = createPostgresStore(database!);
    const secondStore = createPostgresStore(database!);
    const project = await firstStore.createProject({
      name: `agent-auth-${Date.now()}`,
      importKind: "zip",
    });
    const connection = await firstStore.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "future-interactive",
      configEncrypted: "encrypted-config-v1",
    });
    const key = {
      agentConnectionId: connection.id,
      securityRevision: 1,
      authMethod: "future-interactive",
      credentialScope: "principal" as const,
      scopeSubject: "member-a",
      credentialKey: "default",
    };
    await firstStore.putAgentAuthCredential({
      ...key,
      payloadEncrypted: "token-v0",
      expiresAt: null,
    });

    const [winner, loser] = await Promise.all([
      firstStore.replaceAgentAuthCredential({
        ...key,
        expectedRotationSeq: 0,
        payloadEncrypted: "token-v1-a",
        expiresAt: null,
      }),
      secondStore.replaceAgentAuthCredential({
        ...key,
        expectedRotationSeq: 0,
        payloadEncrypted: "token-v1-b",
        expiresAt: null,
      }),
    ]);
    const changed = await firstStore.updateAgentConnection({
      id: connection.id,
      expectedSecurityRevision: 1,
      method: "bearer",
      configEncrypted: "encrypted-config-v2",
      securityChanged: true,
    });
    const stale = await secondStore.updateAgentConnection({
      id: connection.id,
      expectedSecurityRevision: 1,
      method: "none",
      configEncrypted: "encrypted-stale",
      securityChanged: true,
    });

    expect([winner, loser].filter(Boolean)).toHaveLength(1);
    expect(changed).toMatchObject({ method: "bearer", securityRevision: 2 });
    expect(stale).toBeNull();
    await expect(
      firstStore.getAgentAuthCredential({ ...key, securityRevision: 2 }),
    ).resolves.toBeNull();

    await expect(firstStore.deleteProject(project.id)).resolves.toBe(true);
    await expect(firstStore.getAgentConnection(connection.id)).resolves.toBeNull();
    await expect(firstStore.getAgentAuthCredential(key)).resolves.toBeNull();
  }, 30_000);

  test("atomically consumes transactions and fences cross-instance refresh leases", async () => {
    const firstStore = createPostgresStore(database!);
    const secondStore = createPostgresStore(database!);
    const project = await firstStore.createProject({
      name: `agent-auth-lease-${Date.now()}`,
      importKind: "zip",
    });
    const connection = await firstStore.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "oidc",
      configEncrypted: "encrypted-config",
    });
    const key = {
      agentConnectionId: connection.id,
      securityRevision: 1,
      authMethod: "oidc",
      credentialScope: "principal" as const,
      scopeSubject: "member-a",
      credentialKey: "",
    };
    await firstStore.putAgentAuthCredential({
      ...key,
      payloadEncrypted: "token-v0",
      expiresAt: null,
    });
    const now = new Date();
    const [firstClaim, secondClaim] = await Promise.all([
      firstStore.claimAgentAuthCredentialRefresh({
        ...key,
        expectedRotationSeq: 0,
        owner: "instance-a",
        leaseId: "lease-a",
        now,
        leaseUntil: new Date(now.getTime() + 30_000),
      }),
      secondStore.claimAgentAuthCredentialRefresh({
        ...key,
        expectedRotationSeq: 0,
        owner: "instance-b",
        leaseId: "lease-b",
        now,
        leaseUntil: new Date(now.getTime() + 30_000),
      }),
    ]);
    const winner = firstClaim
      ? { store: firstStore, owner: "instance-a", leaseId: "lease-a" }
      : { store: secondStore, owner: "instance-b", leaseId: "lease-b" };
    const loser = firstClaim
      ? { store: secondStore, owner: "instance-b", leaseId: "lease-b" }
      : { store: firstStore, owner: "instance-a", leaseId: "lease-a" };
    expect([firstClaim, secondClaim].filter(Boolean)).toHaveLength(1);
    await expect(
      loser.store.completeAgentAuthCredentialRefresh({
        ...key,
        expectedRotationSeq: 0,
        owner: loser.owner,
        leaseId: loser.leaseId,
        now,
        payloadEncrypted: "loser-token",
        expiresAt: null,
      }),
    ).resolves.toBeNull();
    await expect(
      winner.store.completeAgentAuthCredentialRefresh({
        ...key,
        expectedRotationSeq: 0,
        owner: winner.owner,
        leaseId: winner.leaseId,
        now,
        payloadEncrypted: "winner-token",
        expiresAt: null,
      }),
    ).resolves.toMatchObject({ payloadEncrypted: "winner-token", rotationSeq: 1 });
    await expect(
      winner.store.releaseAgentAuthCredentialRefresh({
        ...key,
        expectedRotationSeq: 0,
        owner: winner.owner,
        leaseId: winner.leaseId,
        now,
      }),
    ).resolves.toBeNull();
    await expect(firstStore.deleteAgentAuthCredential(key, 0)).resolves.toBe(false);

    await firstStore.createAgentAuthTransaction({
      agentConnectionId: connection.id,
      stateHash: "one-time-state",
      payloadEncrypted: "sealed-transaction",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const consumed = await Promise.all([
      firstStore.consumeAgentAuthTransaction("one-time-state"),
      secondStore.consumeAgentAuthTransaction("one-time-state"),
    ]);
    expect(consumed.filter(Boolean)).toHaveLength(1);

    await firstStore.deleteProject(project.id);
  }, 30_000);
});
