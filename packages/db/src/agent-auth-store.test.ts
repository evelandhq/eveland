import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./store.js";

describe("Agent Connection store", () => {
  test("creates a managed Agent Connection that can be resolved by connection or Project", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "protected-agent", importKind: "git", gitUrl: "https://example.com/agent.git" });

    const connection = await store.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "local-dev",
      configEncrypted: "encrypted-local-dev-config",
    });

    expect(connection).toEqual({
      id: expect.stringMatching(/^acon_/),
      target: { kind: "managed-project", projectId: project.id },
      method: "local-dev",
      configEncrypted: "encrypted-local-dev-config",
      securityRevision: 1,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    await expect(store.getAgentConnection(connection.id)).resolves.toEqual(connection);
    await expect(store.getProjectAgentConnection(project.id)).resolves.toEqual(connection);
  });

  test("increments the security revision and rejects a stale connection update", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "revision-agent", importKind: "zip" });
    const connection = await store.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "local-dev",
      configEncrypted: "encrypted-v1",
    });

    const updated = await store.updateAgentConnection({
      id: connection.id,
      expectedSecurityRevision: 1,
      method: "bearer",
      configEncrypted: "encrypted-v2",
    });
    const stale = await store.updateAgentConnection({
      id: connection.id,
      expectedSecurityRevision: 1,
      method: "none",
      configEncrypted: "encrypted-stale",
    });

    expect(updated).toMatchObject({ method: "bearer", configEncrypted: "encrypted-v2", securityRevision: 2 });
    expect(stale).toBeNull();
    await expect(store.getAgentConnection(connection.id)).resolves.toMatchObject({
      method: "bearer",
      configEncrypted: "encrypted-v2",
      securityRevision: 2,
    });
  });

  test("isolates principal-scoped Agent credentials and replaces them with rotation fencing", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "delegated-agent", importKind: "zip" });
    const connection = await store.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "oidc",
      configEncrypted: "encrypted-oidc-config",
    });
    const key = {
      agentConnectionId: connection.id,
      securityRevision: 1,
      authMethod: "oidc",
      credentialScope: "principal" as const,
      scopeSubject: "eveland-member-a",
      credentialKey: "",
    };
    await store.putAgentAuthCredential({
      ...key,
      payloadEncrypted: "encrypted-token-a1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    await store.putAgentAuthCredential({
      ...key,
      scopeSubject: "eveland-member-b",
      payloadEncrypted: "encrypted-token-b1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    const updated = await store.replaceAgentAuthCredential({
      ...key,
      expectedRotationSeq: 0,
      payloadEncrypted: "encrypted-token-a2",
      expiresAt: new Date("2031-01-01T00:00:00.000Z"),
    });
    const stale = await store.replaceAgentAuthCredential({
      ...key,
      expectedRotationSeq: 0,
      payloadEncrypted: "encrypted-token-stale",
      expiresAt: new Date("2032-01-01T00:00:00.000Z"),
    });

    expect(updated).toMatchObject({ scopeSubject: "eveland-member-a", rotationSeq: 1, payloadEncrypted: "encrypted-token-a2" });
    expect(stale).toBeNull();
    await expect(store.getAgentAuthCredential({ ...key, scopeSubject: "eveland-member-b" })).resolves.toMatchObject({
      rotationSeq: 0,
      payloadEncrypted: "encrypted-token-b1",
    });
  });

  test("consumes an OIDC authorization transaction exactly once", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "transaction-agent", importKind: "zip" });
    const connection = await store.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "oidc",
      configEncrypted: "encrypted-oidc-config",
    });
    await store.createAgentAuthTransaction({
      agentConnectionId: connection.id,
      stateHash: "state-sha256",
      payloadEncrypted: "encrypted-pkce-and-context",
      expiresAt: new Date("2030-01-01T00:10:00.000Z"),
    });

    const consumed = await store.consumeAgentAuthTransaction("state-sha256", new Date("2030-01-01T00:05:00.000Z"));
    const replayed = await store.consumeAgentAuthTransaction("state-sha256", new Date("2030-01-01T00:05:01.000Z"));

    expect(consumed).toMatchObject({ stateHash: "state-sha256", payloadEncrypted: "encrypted-pkce-and-context" });
    expect(replayed).toBeNull();
  });

  test("fences an Agent credential refresh with both rotation and lease identity", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "refresh-agent", importKind: "zip" });
    const connection = await store.createAgentConnection({
      target: { kind: "managed-project", projectId: project.id },
      method: "oidc",
      configEncrypted: "encrypted-oidc-config",
    });
    const key = {
      agentConnectionId: connection.id,
      securityRevision: 1,
      authMethod: "oidc",
      credentialScope: "principal" as const,
      scopeSubject: "eveland-member-a",
      credentialKey: "",
    };
    await store.putAgentAuthCredential({
      ...key,
      payloadEncrypted: "encrypted-token-v0",
      expiresAt: new Date("2029-01-01T00:00:00.000Z"),
    });

    const firstLease = await store.claimAgentAuthCredentialRefresh({
      ...key,
      expectedRotationSeq: 0,
      owner: "api-a",
      leaseId: "lease-a",
      leaseUntil: new Date("2029-01-01T00:00:30.000Z"),
      now: new Date("2029-01-01T00:00:00.000Z"),
    });
    const competingLease = await store.claimAgentAuthCredentialRefresh({
      ...key,
      expectedRotationSeq: 0,
      owner: "api-b",
      leaseId: "lease-b",
      leaseUntil: new Date("2029-01-01T00:00:30.000Z"),
      now: new Date("2029-01-01T00:00:01.000Z"),
    });
    const staleCompletion = await store.completeAgentAuthCredentialRefresh({
      ...key,
      expectedRotationSeq: 0,
      owner: "api-b",
      leaseId: "lease-b",
      payloadEncrypted: "encrypted-stale",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    const completed = await store.completeAgentAuthCredentialRefresh({
      ...key,
      expectedRotationSeq: 0,
      owner: "api-a",
      leaseId: "lease-a",
      payloadEncrypted: "encrypted-token-v1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    expect(firstLease).toMatchObject({ refreshOwner: "api-a", refreshLeaseId: "lease-a" });
    expect(competingLease).toBeNull();
    expect(staleCompletion).toBeNull();
    expect(completed).toMatchObject({ rotationSeq: 1, payloadEncrypted: "encrypted-token-v1", refreshLeaseId: null });
  });
});
