import { createId } from "@eveland/core/ids";
import { and, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  agentAuthCredentialRowToAgentAuthCredential,
  agentAuthTransactionRowToAgentAuthTransaction,
  agentConnectionRowToAgentConnection,
} from "./mappers.js";
import {
  agentAuthCredentials,
  agentAuthTransactions,
  agentConnections,
} from "./schema.js";


import type { AgentAuthStore } from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";
import {
  agentAuthCredentialWhere,
  isUniqueConstraint,
} from "./postgres-store-support.js";

export function createPostgresAgentAuthStore({
  db,
}: PostgresStoreContext): AgentAuthStore {
  return {
    async createAgentConnection(input) {
      try {
        const [row] = await db
          .insert(agentConnections)
          .values({
            id: input.id ?? createId("acon"),
            projectId: input.target.projectId,
            targetKind: input.target.kind,
            method: input.method,
            configEncrypted: input.configEncrypted,
            securityRevision: 1,
          })
          .returning();
        if (!row) throw new Error("Failed to create Agent Connection.");
        return agentConnectionRowToAgentConnection(row);
      } catch (error) {
        if (isUniqueConstraint(error, "agent_connections_project_idx")) {
          throw new Error("An Agent Connection already exists for this Project.");
        }
        throw error;
      }
    },

    async getAgentConnection(agentConnectionId) {
      const [row] = await db
        .select()
        .from(agentConnections)
        .where(eq(agentConnections.id, agentConnectionId))
        .limit(1);
      return row ? agentConnectionRowToAgentConnection(row) : null;
    },

    async getProjectAgentConnection(projectId) {
      const [row] = await db
        .select()
        .from(agentConnections)
        .where(eq(agentConnections.projectId, projectId))
        .limit(1);
      return row ? agentConnectionRowToAgentConnection(row) : null;
    },

    async updateAgentConnection(input) {
      const [row] = await db
        .update(agentConnections)
        .set({
          method: input.method,
          configEncrypted: input.configEncrypted,
          securityRevision: input.securityChanged
            ? sql`${agentConnections.securityRevision} + 1`
            : input.expectedSecurityRevision,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentConnections.id, input.id),
            eq(
              agentConnections.securityRevision,
              input.expectedSecurityRevision,
            ),
          ),
        )
        .returning();
      return row ? agentConnectionRowToAgentConnection(row) : null;
    },

    async putAgentAuthCredential(input) {
      const [row] = await db
        .insert(agentAuthCredentials)
        .values(input)
        .onConflictDoUpdate({
          target: [
            agentAuthCredentials.agentConnectionId,
            agentAuthCredentials.securityRevision,
            agentAuthCredentials.authMethod,
            agentAuthCredentials.credentialScope,
            agentAuthCredentials.scopeSubject,
            agentAuthCredentials.credentialKey,
          ],
          set: {
            payloadEncrypted: input.payloadEncrypted,
            expiresAt: input.expiresAt,
            rotationSeq: sql`${agentAuthCredentials.rotationSeq} + 1`,
            refreshOwner: null,
            refreshLeaseId: null,
            refreshLeaseUntil: null,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error("Failed to store Agent credential.");
      return agentAuthCredentialRowToAgentAuthCredential(row);
    },

    async getAgentAuthCredential(key) {
      const [row] = await db
        .select()
        .from(agentAuthCredentials)
        .where(agentAuthCredentialWhere(key))
        .limit(1);
      return row ? agentAuthCredentialRowToAgentAuthCredential(row) : null;
    },

    async deleteAgentAuthCredential(key, expectedRotationSeq) {
      const [row] = await db
        .delete(agentAuthCredentials)
        .where(
          and(
            agentAuthCredentialWhere(key),
            eq(agentAuthCredentials.rotationSeq, expectedRotationSeq),
          ),
        )
        .returning({ rotationSeq: agentAuthCredentials.rotationSeq });
      return Boolean(row);
    },

    async replaceAgentAuthCredential(input) {
      const [row] = await db
        .update(agentAuthCredentials)
        .set({
          payloadEncrypted: input.payloadEncrypted,
          expiresAt: input.expiresAt,
          rotationSeq: sql`${agentAuthCredentials.rotationSeq} + 1`,
          refreshOwner: null,
          refreshLeaseId: null,
          refreshLeaseUntil: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            agentAuthCredentialWhere(input),
            eq(agentAuthCredentials.rotationSeq, input.expectedRotationSeq),
          ),
        )
        .returning();
      return row ? agentAuthCredentialRowToAgentAuthCredential(row) : null;
    },

    async claimAgentAuthCredentialRefresh(input) {
      const [row] = await db
        .update(agentAuthCredentials)
        .set({
          refreshOwner: input.owner,
          refreshLeaseId: input.leaseId,
          refreshLeaseUntil: input.leaseUntil,
          updatedAt: input.now,
        })
        .where(
          and(
            agentAuthCredentialWhere(input),
            eq(agentAuthCredentials.rotationSeq, input.expectedRotationSeq),
            or(
              isNull(agentAuthCredentials.refreshLeaseUntil),
              lte(agentAuthCredentials.refreshLeaseUntil, input.now),
            ),
          ),
        )
        .returning();
      return row ? agentAuthCredentialRowToAgentAuthCredential(row) : null;
    },

    async completeAgentAuthCredentialRefresh(input) {
      const [row] = await db
        .update(agentAuthCredentials)
        .set({
          payloadEncrypted: input.payloadEncrypted,
          expiresAt: input.expiresAt,
          rotationSeq: sql`${agentAuthCredentials.rotationSeq} + 1`,
          refreshOwner: null,
          refreshLeaseId: null,
          refreshLeaseUntil: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            agentAuthCredentialWhere(input),
            eq(agentAuthCredentials.rotationSeq, input.expectedRotationSeq),
            eq(agentAuthCredentials.refreshOwner, input.owner),
            eq(agentAuthCredentials.refreshLeaseId, input.leaseId),
            gt(agentAuthCredentials.refreshLeaseUntil, input.now),
          ),
        )
        .returning();
      return row ? agentAuthCredentialRowToAgentAuthCredential(row) : null;
    },

    async releaseAgentAuthCredentialRefresh(input) {
      const [row] = await db
        .update(agentAuthCredentials)
        .set({
          refreshOwner: null,
          refreshLeaseId: null,
          refreshLeaseUntil: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            agentAuthCredentialWhere(input),
            eq(agentAuthCredentials.rotationSeq, input.expectedRotationSeq),
            eq(agentAuthCredentials.refreshOwner, input.owner),
            eq(agentAuthCredentials.refreshLeaseId, input.leaseId),
            gt(agentAuthCredentials.refreshLeaseUntil, input.now),
          ),
        )
        .returning();
      return row ? agentAuthCredentialRowToAgentAuthCredential(row) : null;
    },

    async createAgentAuthTransaction(input) {
      const [row] = await db
        .insert(agentAuthTransactions)
        .values(input)
        .returning();
      if (!row) throw new Error("Failed to create Agent Auth transaction.");
      return agentAuthTransactionRowToAgentAuthTransaction(row);
    },

    async consumeAgentAuthTransaction(stateHash, now = new Date()) {
      const [row] = await db
        .delete(agentAuthTransactions)
        .where(eq(agentAuthTransactions.stateHash, stateHash))
        .returning();
      return row && row.expiresAt > now
        ? agentAuthTransactionRowToAgentAuthTransaction(row)
        : null;
    },

    async deleteExpiredAgentAuthTransactions(now = new Date(), limit = 100) {
      const rows = await db
        .delete(agentAuthTransactions)
        .where(
          inArray(
            agentAuthTransactions.stateHash,
            db
              .select({ stateHash: agentAuthTransactions.stateHash })
              .from(agentAuthTransactions)
              .where(lte(agentAuthTransactions.expiresAt, now))
              .limit(limit),
          ),
        )
        .returning({ stateHash: agentAuthTransactions.stateHash });
      return rows.length;
    },

    async deleteStaleAgentAuthCredentials(
      agentConnectionId,
      currentSecurityRevision,
    ) {
      const credentials = await db
        .delete(agentAuthCredentials)
        .where(
          and(
            eq(agentAuthCredentials.agentConnectionId, agentConnectionId),
            lt(agentAuthCredentials.securityRevision, currentSecurityRevision),
          ),
        )
        .returning({ rotationSeq: agentAuthCredentials.rotationSeq });
      return credentials.length;
    },
  };
}
