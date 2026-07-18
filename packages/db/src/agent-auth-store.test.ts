import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

describe("Agent Connection store", () => {
  test("creates one managed Agent Connection per Project", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "protected-agent", importKind: "git", gitUrl: "https://example.com/agent.git" });

    const connection = await store.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "local-dev",
      configEncrypted: "encrypted-local-dev-config",
    });

    expect(connection).toMatchObject({
      id: expect.stringMatching(/^acon_/),
      target: { kind: "managed-project", projectId: project.id },
      method: "local-dev",
      configEncrypted: "encrypted-local-dev-config",
      securityRevision: 1,
    });
    await expect(store.getProjectAgentConnection(project.id)).resolves.toEqual(connection);
    await expect(store.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "none",
      configEncrypted: "encrypted-none-config",
    })).rejects.toThrow(/already exists/i);
  });

  test("keeps the revision for a semantic no-op and increments it for a security change", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "revision-agent", importKind: "zip" });
    const connection = await store.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "basic",
      configEncrypted: "encrypted-v1",
    });

    const unchanged = await store.updateAgentConnection({
      id: connection.id,
      expectedSecurityRevision: 1,
      method: "basic",
      configEncrypted: "encrypted-v1-new-iv",
      securityChanged: false,
    });
    const changed = await store.updateAgentConnection({
      id: connection.id,
      expectedSecurityRevision: 1,
      method: "bearer",
      configEncrypted: "encrypted-v2",
      securityChanged: true,
    });
    const stale = await store.updateAgentConnection({
      id: connection.id,
      expectedSecurityRevision: 1,
      method: "none",
      configEncrypted: "encrypted-stale",
      securityChanged: true,
    });

    expect(unchanged).toMatchObject({ securityRevision: 1, configEncrypted: "encrypted-v1-new-iv" });
    expect(changed).toMatchObject({ method: "bearer", securityRevision: 2 });
    expect(stale).toBeNull();
  });

  test("isolates principal credentials and fences replacement by revision and rotation", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "delegated-agent", importKind: "zip" });
    const connection = await store.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "future-interactive",
      configEncrypted: "encrypted-config",
    });
    const key = {
      agentConnectionId: connection.id,
      securityRevision: 1,
      authMethod: "future-interactive",
      credentialScope: "principal" as const,
      scopeSubject: "member-a",
      credentialKey: "default",
    };
    await store.putAgentAuthCredential({ ...key, payloadEncrypted: "token-a1", expiresAt: null });
    await store.putAgentAuthCredential({ ...key, scopeSubject: "member-b", payloadEncrypted: "token-b1", expiresAt: null });

    const replaced = await store.replaceAgentAuthCredential({
      ...key,
      expectedRotationSeq: 0,
      payloadEncrypted: "token-a2",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    const staleRotation = await store.replaceAgentAuthCredential({
      ...key,
      expectedRotationSeq: 0,
      payloadEncrypted: "token-stale",
      expiresAt: null,
    });

    expect(replaced).toMatchObject({ payloadEncrypted: "token-a2", rotationSeq: 1 });
    expect(staleRotation).toBeNull();
    await expect(store.getAgentAuthCredential({ ...key, scopeSubject: "member-b" })).resolves.toMatchObject({
      payloadEncrypted: "token-b1",
      rotationSeq: 0,
    });
    await expect(store.getAgentAuthCredential({ ...key, securityRevision: 2 })).resolves.toBeNull();
  });

  test("deleting a Project cascades its Connection and credentials", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "deleted-agent", importKind: "zip" });
    const connection = await store.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "bearer",
      configEncrypted: "encrypted-config",
    });
    const key = {
      agentConnectionId: connection.id,
      securityRevision: 1,
      authMethod: "bearer",
      credentialScope: "connection" as const,
      scopeSubject: "",
      credentialKey: "default",
    };
    await store.putAgentAuthCredential({ ...key, payloadEncrypted: "encrypted-token", expiresAt: null });

    await expect(store.deleteProject(project.id)).resolves.toBe(true);
    await expect(store.getAgentConnection(connection.id)).resolves.toBeNull();
    await expect(store.getAgentAuthCredential(key)).resolves.toBeNull();
  });

  test("cleans expired transactions and stale security revisions", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "cleanup-agent-auth", importKind: "zip" });
    const connection = await store.createAgentConnection({
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
    await store.putAgentAuthCredential({ ...key, payloadEncrypted: "credential-v1", expiresAt: null });
    const leaseNow = new Date("2029-01-01T00:00:00.000Z");
    await expect(store.claimAgentAuthCredentialRefresh({
      ...key,
      expectedRotationSeq: 0,
      owner: "slow-instance",
      leaseId: "expired-lease",
      now: leaseNow,
      leaseUntil: new Date("2029-01-01T00:00:30.000Z"),
    })).resolves.not.toBeNull();
    await expect(store.completeAgentAuthCredentialRefresh({
      ...key,
      expectedRotationSeq: 0,
      owner: "slow-instance",
      leaseId: "expired-lease",
      now: new Date("2029-01-01T00:00:31.000Z"),
      payloadEncrypted: "late-token",
      expiresAt: null,
    })).resolves.toBeNull();
    await expect(store.releaseAgentAuthCredentialRefresh({
      ...key,
      expectedRotationSeq: 0,
      owner: "slow-instance",
      leaseId: "expired-lease",
      now: new Date("2029-01-01T00:00:31.000Z"),
    })).resolves.toBeNull();
    await store.createAgentAuthTransaction({
      agentConnectionId: connection.id,
      stateHash: "expired-state",
      payloadEncrypted: "expired-transaction",
      expiresAt: new Date("2029-01-01T00:00:00.000Z"),
    });
    await store.createAgentAuthTransaction({
      agentConnectionId: connection.id,
      stateHash: "active-state",
      payloadEncrypted: "active-transaction",
      expiresAt: new Date("2031-01-01T00:00:00.000Z"),
    });

    await expect(store.deleteExpiredAgentAuthTransactions(new Date("2030-01-01T00:00:00.000Z"), 10)).resolves.toBe(1);
    await expect(store.consumeAgentAuthTransaction("expired-state", new Date("2028-01-01T00:00:00.000Z"))).resolves.toBeNull();
    await expect(store.deleteStaleAgentAuthCredentials(connection.id, 2)).resolves.toBe(1);
    await expect(store.getAgentAuthCredential(key)).resolves.toBeNull();
    await expect(store.consumeAgentAuthTransaction("active-state", new Date("2030-01-01T00:00:00.000Z"))).resolves.toMatchObject({
      payloadEncrypted: "active-transaction",
    });
  });
});
