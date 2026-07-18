import type { AgentAuthCredential, AgentAuthTransaction, AgentConnection } from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import type { MemoryState } from "./memory-state.js";
import type { MemoryDomain } from "./memory-store-support.js";
import type { AgentAuthCredentialKey, AgentAuthStore } from "./store-domains.js";

export function createMemoryAgentAuthStore(state: MemoryState): MemoryDomain<AgentAuthStore> {
  return {
    async createAgentConnection(input) {
      if (!state.projects.some((project) => project.id === input.target.projectId)) {
        throw new Error("Cannot create an Agent Connection for an unknown Project.");
      }
      if (state.agentConnections.some((connection) => connection.target.projectId === input.target.projectId)) {
        throw new Error("A managed Agent Connection already exists for this Project.");
      }
      const now = new Date().toISOString();
      const connection: AgentConnection = {
        id: input.id ?? createId("acon"),
        target: input.target,
        method: input.method,
        configEncrypted: input.configEncrypted,
        securityRevision: 1,
        createdAt: now,
        updatedAt: now,
      };
      state.agentConnections.push(connection);
      return { ...connection, target: { ...connection.target } };
    },

    async getAgentConnection(agentConnectionId) {
      const connection = state.agentConnections.find((candidate) => candidate.id === agentConnectionId);
      return connection ? { ...connection, target: { ...connection.target } } : null;
    },

    async getProjectAgentConnection(projectId) {
      const connection = state.agentConnections.find((candidate) => candidate.target.projectId === projectId);
      return connection ? { ...connection, target: { ...connection.target } } : null;
    },

    async updateAgentConnection(input) {
      const connection = state.agentConnections.find(
        (candidate) => candidate.id === input.id && candidate.securityRevision === input.expectedSecurityRevision,
      );
      if (!connection) return null;
      connection.method = input.method;
      connection.configEncrypted = input.configEncrypted;
      if (input.securityChanged) connection.securityRevision += 1;
      connection.updatedAt = new Date().toISOString();
      return { ...connection, target: { ...connection.target } };
    },

    async putAgentAuthCredential(input) {
      assertCredentialScope(input);
      const existing = state.agentAuthCredentials.find((credential) => agentAuthCredentialMatches(credential, input));
      const now = new Date().toISOString();
      if (existing) {
        existing.payloadEncrypted = input.payloadEncrypted;
        existing.expiresAt = input.expiresAt?.toISOString() ?? null;
        existing.rotationSeq += 1;
        existing.refreshOwner = null;
        existing.refreshLeaseId = null;
        existing.refreshLeaseUntil = null;
        existing.updatedAt = now;
        return { ...existing };
      }
      const credential: AgentAuthCredential = {
        ...input,
        expiresAt: input.expiresAt?.toISOString() ?? null,
        rotationSeq: 0,
        refreshOwner: null,
        refreshLeaseId: null,
        refreshLeaseUntil: null,
        createdAt: now,
        updatedAt: now,
      };
      state.agentAuthCredentials.push(credential);
      return { ...credential };
    },

    async getAgentAuthCredential(key) {
      const credential = state.agentAuthCredentials.find((candidate) => agentAuthCredentialMatches(candidate, key));
      return credential ? { ...credential } : null;
    },

    async deleteAgentAuthCredential(key, expectedRotationSeq) {
      const index = state.agentAuthCredentials.findIndex(
        (credential) => agentAuthCredentialMatches(credential, key) && credential.rotationSeq === expectedRotationSeq,
      );
      if (index < 0) return false;
      state.agentAuthCredentials.splice(index, 1);
      return true;
    },

    async replaceAgentAuthCredential(input) {
      const credential = state.agentAuthCredentials.find(
        (candidate) => agentAuthCredentialMatches(candidate, input) && candidate.rotationSeq === input.expectedRotationSeq,
      );
      if (!credential) return null;
      credential.payloadEncrypted = input.payloadEncrypted;
      credential.expiresAt = input.expiresAt?.toISOString() ?? null;
      credential.rotationSeq += 1;
      credential.refreshOwner = null;
      credential.refreshLeaseId = null;
      credential.refreshLeaseUntil = null;
      credential.updatedAt = new Date().toISOString();
      return { ...credential };
    },

    async claimAgentAuthCredentialRefresh(input) {
      const credential = state.agentAuthCredentials.find(
        (candidate) => agentAuthCredentialMatches(candidate, input)
          && candidate.rotationSeq === input.expectedRotationSeq
          && (!candidate.refreshLeaseUntil || candidate.refreshLeaseUntil <= input.now.toISOString()),
      );
      if (!credential) return null;
      credential.refreshOwner = input.owner;
      credential.refreshLeaseId = input.leaseId;
      credential.refreshLeaseUntil = input.leaseUntil.toISOString();
      credential.updatedAt = input.now.toISOString();
      return { ...credential };
    },

    async completeAgentAuthCredentialRefresh(input) {
      const credential = state.agentAuthCredentials.find(
        (candidate) => agentAuthCredentialMatches(candidate, input)
          && candidate.rotationSeq === input.expectedRotationSeq
          && candidate.refreshOwner === input.owner
          && candidate.refreshLeaseId === input.leaseId
          && candidate.refreshLeaseUntil !== null
          && candidate.refreshLeaseUntil > input.now.toISOString(),
      );
      if (!credential) return null;
      credential.payloadEncrypted = input.payloadEncrypted;
      credential.expiresAt = input.expiresAt?.toISOString() ?? null;
      credential.rotationSeq += 1;
      credential.refreshOwner = null;
      credential.refreshLeaseId = null;
      credential.refreshLeaseUntil = null;
      credential.updatedAt = new Date().toISOString();
      return { ...credential };
    },

    async releaseAgentAuthCredentialRefresh(input) {
      const credential = state.agentAuthCredentials.find(
        (candidate) => agentAuthCredentialMatches(candidate, input)
          && candidate.rotationSeq === input.expectedRotationSeq
          && candidate.refreshOwner === input.owner
          && candidate.refreshLeaseId === input.leaseId
          && candidate.refreshLeaseUntil !== null
          && candidate.refreshLeaseUntil > input.now.toISOString(),
      );
      if (!credential) return null;
      credential.refreshOwner = null;
      credential.refreshLeaseId = null;
      credential.refreshLeaseUntil = null;
      credential.updatedAt = new Date().toISOString();
      return { ...credential };
    },

    async createAgentAuthTransaction(input) {
      if (state.agentAuthTransactions.some((transaction) => transaction.stateHash === input.stateHash)) {
        throw new Error("Agent Auth transaction already exists.");
      }
      const transaction: AgentAuthTransaction = {
        agentConnectionId: input.agentConnectionId,
        stateHash: input.stateHash,
        payloadEncrypted: input.payloadEncrypted,
        expiresAt: input.expiresAt.toISOString(),
        createdAt: new Date().toISOString(),
      };
      state.agentAuthTransactions.push(transaction);
      return { ...transaction };
    },

    async consumeAgentAuthTransaction(stateHash, now = new Date()) {
      const index = state.agentAuthTransactions.findIndex((transaction) => transaction.stateHash === stateHash);
      if (index < 0) return null;
      const [transaction] = state.agentAuthTransactions.splice(index, 1);
      return transaction && transaction.expiresAt > now.toISOString() ? { ...transaction } : null;
    },

    async deleteExpiredAgentAuthTransactions(now = new Date(), limit = 100) {
      const expired = state.agentAuthTransactions
        .filter((transaction) => transaction.expiresAt <= now.toISOString())
        .slice(0, limit);
      const hashes = new Set(expired.map((transaction) => transaction.stateHash));
      state.agentAuthTransactions = state.agentAuthTransactions.filter((transaction) => !hashes.has(transaction.stateHash));
      return expired.length;
    },

    async deleteStaleAgentAuthCredentials(agentConnectionId, currentSecurityRevision) {
      const credentialsBefore = state.agentAuthCredentials.length;
      state.agentAuthCredentials = state.agentAuthCredentials.filter(
        (credential) => credential.agentConnectionId !== agentConnectionId
          || credential.securityRevision >= currentSecurityRevision,
      );
      return credentialsBefore - state.agentAuthCredentials.length;
    },

  };
}

function agentAuthCredentialMatches(credential: AgentAuthCredential, key: AgentAuthCredentialKey): boolean {
  return (
    credential.agentConnectionId === key.agentConnectionId &&
    credential.securityRevision === key.securityRevision &&
    credential.authMethod === key.authMethod &&
    credential.credentialScope === key.credentialScope &&
    credential.scopeSubject === key.scopeSubject &&
    credential.credentialKey === key.credentialKey
  );
}

function assertCredentialScope(key: AgentAuthCredentialKey): void {
  if (
    (key.credentialScope === "connection" && key.scopeSubject !== "")
    || (key.credentialScope === "principal" && key.scopeSubject === "")
  ) {
    throw new Error("Agent credential scope subject does not match its scope.");
  }
}
