import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.EVELAND_POSTGRES_TEST_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

describe.skipIf(!database)("Postgres Agent Auth fencing", () => {
  test("allows one refresh lease owner and consumes an authorization transaction once across store instances", async () => {
    const firstStore = createPostgresStore(database!);
    const secondStore = createPostgresStore(database!);
    const project = await firstStore.createProject({ name: `Agent auth integration ${Date.now()}`, importKind: "zip" });
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
      scopeSubject: "member-postgres",
      credentialKey: "",
    };

    try {
      await firstStore.putAgentAuthCredential({
        ...key,
        payloadEncrypted: "encrypted-token-v0",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      });
      const claims = await Promise.all([
        firstStore.claimAgentAuthCredentialRefresh({
          ...key,
          expectedRotationSeq: 0,
          owner: "api-a",
          leaseId: "lease-a",
          now: new Date("2029-01-01T00:00:00.000Z"),
          leaseUntil: new Date("2029-01-01T00:00:30.000Z"),
        }),
        secondStore.claimAgentAuthCredentialRefresh({
          ...key,
          expectedRotationSeq: 0,
          owner: "api-b",
          leaseId: "lease-b",
          now: new Date("2029-01-01T00:00:00.000Z"),
          leaseUntil: new Date("2029-01-01T00:00:30.000Z"),
        }),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);

      await firstStore.createAgentAuthTransaction({
        agentConnectionId: connection.id,
        stateHash: `state-${Date.now()}`,
        payloadEncrypted: "encrypted-transaction",
        expiresAt: new Date("2030-01-01T00:10:00.000Z"),
      }).then(async (transaction) => {
        const consumed = await Promise.all([
          firstStore.consumeAgentAuthTransaction(transaction.stateHash, new Date("2030-01-01T00:00:00.000Z")),
          secondStore.consumeAgentAuthTransaction(transaction.stateHash, new Date("2030-01-01T00:00:00.000Z")),
        ]);
        expect(consumed.filter(Boolean)).toHaveLength(1);
      });
    } finally {
      await firstStore.deleteProject(project.id);
    }
  });
});
