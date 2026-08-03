import { and, asc, desc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { createId } from "@eveland/core/ids";
import type {
  ExternalRealmKind,
  IdentityLoginTransaction,
  IdentityOidcCredential,
  IdentityPrincipal,
  IdentityProviderConnection,
  IdentityRealm,
  IdentityReturnTarget,
  IdentitySession,
  IdentitySigningKey,
  IdentitySigningKeyStatus,
} from "@eveland/core/identity";
import {
  identityLoginTransactions,
  identityOidcCredentials,
  identityPrincipals,
  identityProviderConnections,
  identityRealms,
  identityReturnTargets,
  identitySessions,
  identitySigningKeys,
} from "./schema.js";
import type { IdentityStore } from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";

type ProviderRow = typeof identityProviderConnections.$inferSelect;
type RealmRow = typeof identityRealms.$inferSelect;
type PrincipalRow = typeof identityPrincipals.$inferSelect;
type SessionRow = typeof identitySessions.$inferSelect;
type TransactionRow = typeof identityLoginTransactions.$inferSelect;
type ReturnTargetRow = typeof identityReturnTargets.$inferSelect;
type OidcCredentialRow = typeof identityOidcCredentials.$inferSelect;
type SigningKeyRow = typeof identitySigningKeys.$inferSelect;

export function createPostgresIdentityStore(context: PostgresStoreContext): IdentityStore {
  const { db } = context;

  return {
    async createIdentityProviderConnection(input) {
      const [row] = await db
        .insert(identityProviderConnections)
        .values(providerValues(input))
        .returning();
      if (!row) throw new Error("Failed to create Identity Provider Connection.");
      return providerRow(row);
    },

    async listIdentityProviderConnections() {
      return (
        await db
          .select()
          .from(identityProviderConnections)
          .orderBy(asc(identityProviderConnections.createdAt))
      ).map(providerRow);
    },

    async getIdentityProviderConnection(id) {
      const [row] = await db
        .select()
        .from(identityProviderConnections)
        .where(eq(identityProviderConnections.id, id))
        .limit(1);
      return row ? providerRow(row) : null;
    },

    async updateIdentityProviderConnection(input) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(identityProviderConnections)
          .where(
            and(
              eq(identityProviderConnections.id, input.id),
              eq(identityProviderConnections.securityRevision, input.expectedSecurityRevision),
            ),
          )
          .limit(1);
        if (!current) return null;
        if (
          current.type === "internal" &&
          input.internalRealmKey !== undefined &&
          input.internalRealmKey !== current.internalRealmKey
        ) {
          throw new Error("Internal Realm key is immutable.");
        }

        const [updated] = await tx
          .update(identityProviderConnections)
          .set({
            displayName: input.displayName,
            enabled: input.enabled,
            ...(current.type === "oidc"
              ? {
                  ...(input.issuer !== undefined ? { issuer: input.issuer } : {}),
                  ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
                  ...(input.clientSecretEncrypted !== undefined
                    ? { clientSecretEncrypted: input.clientSecretEncrypted }
                    : {}),
                  ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
                  ...(input.authorizationParameters !== undefined
                    ? { authorizationParameters: input.authorizationParameters }
                    : {}),
                  ...(input.tokenEndpointAuthMethod !== undefined
                    ? { tokenEndpointAuthMethod: input.tokenEndpointAuthMethod }
                    : {}),
                  ...(input.externalRealmResolution !== undefined
                    ? { externalRealmResolution: input.externalRealmResolution }
                    : {}),
                  ...(input.externalRealmClaim !== undefined
                    ? { externalRealmClaim: input.externalRealmClaim }
                    : {}),
                }
              : {}),
            securityRevision: input.securityChanged
              ? current.securityRevision + 1
              : current.securityRevision,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(identityProviderConnections.id, input.id),
              eq(identityProviderConnections.securityRevision, input.expectedSecurityRevision),
            ),
          )
          .returning();
        if (!updated) return null;

        if (input.securityChanged) {
          const realms = await tx
            .select({ id: identityRealms.id })
            .from(identityRealms)
            .where(eq(identityRealms.providerConnectionId, input.id));
          const realmIds = realms.map((realm) => realm.id);
          if (realmIds.length > 0) {
            const principals = await tx
              .select({ id: identityPrincipals.id })
              .from(identityPrincipals)
              .where(inArray(identityPrincipals.identityRealmId, realmIds));
            const principalIds = principals.map((principal) => principal.id);
            if (principalIds.length > 0) {
              await tx
                .update(identitySessions)
                .set({ revokedAt: new Date() })
                .where(
                  and(
                    inArray(identitySessions.identityPrincipalId, principalIds),
                    isNull(identitySessions.revokedAt),
                  ),
                );
            }
          }
          await tx
            .delete(identityLoginTransactions)
            .where(eq(identityLoginTransactions.providerConnectionId, input.id));
          await tx
            .delete(identityOidcCredentials)
            .where(eq(identityOidcCredentials.providerConnectionId, input.id));
        }
        return providerRow(updated);
      });
    },

    async createIdentityRealm(input) {
      const inserted = await db
        .insert(identityRealms)
        .values({
          id: createId("irlm"),
          providerConnectionId: input.providerConnectionId,
          externalRealmId: input.externalRealmId,
          externalRealmKind: input.externalRealmKind,
          displayName: input.displayName,
          enabled: input.enabled,
        })
        .onConflictDoNothing({
          target: [identityRealms.providerConnectionId, identityRealms.externalRealmId],
        })
        .returning();
      const row =
        inserted[0] ??
        (
          await db
            .select()
            .from(identityRealms)
            .where(
              and(
                eq(identityRealms.providerConnectionId, input.providerConnectionId),
                eq(identityRealms.externalRealmId, input.externalRealmId),
              ),
            )
            .limit(1)
        )[0];
      if (!row) throw new Error("Failed to create Identity Realm.");
      return realmRow(row);
    },

    async listIdentityRealms(providerConnectionId) {
      const rows = providerConnectionId
        ? await db
            .select()
            .from(identityRealms)
            .where(eq(identityRealms.providerConnectionId, providerConnectionId))
            .orderBy(asc(identityRealms.createdAt))
        : await db.select().from(identityRealms).orderBy(asc(identityRealms.createdAt));
      return rows.map(realmRow);
    },

    async getIdentityRealm(id) {
      const [row] = await db
        .select()
        .from(identityRealms)
        .where(eq(identityRealms.id, id))
        .limit(1);
      return row ? realmRow(row) : null;
    },

    async getIdentityRealmByExternalId(providerConnectionId, externalRealmId) {
      const [row] = await db
        .select()
        .from(identityRealms)
        .where(
          and(
            eq(identityRealms.providerConnectionId, providerConnectionId),
            eq(identityRealms.externalRealmId, externalRealmId),
          ),
        )
        .limit(1);
      return row ? realmRow(row) : null;
    },

    async updateIdentityRealm(id, input) {
      const [row] = await db
        .update(identityRealms)
        .set({
          displayName: input.displayName,
          enabled: input.enabled,
          updatedAt: new Date(),
        })
        .where(eq(identityRealms.id, id))
        .returning();
      return row ? realmRow(row) : null;
    },

    async upsertIdentityPrincipal(input) {
      const [row] = await db
        .insert(identityPrincipals)
        .values({
          id: createId("iprn"),
          identityRealmId: input.identityRealmId,
          externalSubject: input.externalSubject,
          displayName: input.displayName,
          email: input.email,
          claims: input.claims,
        })
        .onConflictDoUpdate({
          target: [identityPrincipals.identityRealmId, identityPrincipals.externalSubject],
          set: {
            displayName: input.displayName,
            email: input.email,
            claims: input.claims,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error("Failed to upsert Identity Principal.");
      return principalRow(row);
    },

    async getIdentityPrincipal(id) {
      const [row] = await db
        .select()
        .from(identityPrincipals)
        .where(eq(identityPrincipals.id, id))
        .limit(1);
      return row ? principalRow(row) : null;
    },

    async createIdentitySession(input) {
      const [row] = await db
        .insert(identitySessions)
        .values({
          id: createId("ises"),
          tokenHash: input.tokenHash,
          identityPrincipalId: input.identityPrincipalId,
          activeIdentityRealmId: input.activeIdentityRealmId,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!row) throw new Error("Failed to create Identity Session.");
      return sessionRow(row);
    },

    async getActiveIdentitySession(tokenHash, now = new Date()) {
      const [row] = await db
        .update(identitySessions)
        .set({ lastSeenAt: now })
        .where(
          and(
            eq(identitySessions.tokenHash, tokenHash),
            isNull(identitySessions.revokedAt),
            gt(identitySessions.expiresAt, now),
          ),
        )
        .returning();
      return row ? sessionRow(row) : null;
    },

    async revokeIdentitySession(id, now = new Date()) {
      const [row] = await db
        .update(identitySessions)
        .set({ revokedAt: now })
        .where(eq(identitySessions.id, id))
        .returning();
      return row ? sessionRow(row) : null;
    },

    async revokeIdentitySessionByTokenHash(tokenHash, now = new Date()) {
      const rows = await db
        .update(identitySessions)
        .set({ revokedAt: now })
        .where(and(eq(identitySessions.tokenHash, tokenHash), isNull(identitySessions.revokedAt)))
        .returning({ id: identitySessions.id });
      return rows.length > 0;
    },

    async createIdentityLoginTransaction(input) {
      const [row] = await db.insert(identityLoginTransactions).values(input).returning();
      if (!row) throw new Error("Failed to create Identity login transaction.");
      return transactionRow(row);
    },

    async consumeIdentityLoginTransaction(stateHash, now = new Date()) {
      const [row] = await db
        .update(identityLoginTransactions)
        .set({ consumedAt: now })
        .where(
          and(
            eq(identityLoginTransactions.stateHash, stateHash),
            isNull(identityLoginTransactions.consumedAt),
            gt(identityLoginTransactions.expiresAt, now),
          ),
        )
        .returning();
      return row ? transactionRow(row) : null;
    },

    async deleteExpiredIdentityLoginTransactions(now = new Date(), limit = 100) {
      const candidates = await db
        .select({ stateHash: identityLoginTransactions.stateHash })
        .from(identityLoginTransactions)
        .where(lt(identityLoginTransactions.expiresAt, now))
        .orderBy(asc(identityLoginTransactions.expiresAt))
        .limit(limit);
      if (candidates.length === 0) return 0;
      const rows = await db
        .delete(identityLoginTransactions)
        .where(
          inArray(
            identityLoginTransactions.stateHash,
            candidates.map((candidate) => candidate.stateHash),
          ),
        )
        .returning({ stateHash: identityLoginTransactions.stateHash });
      return rows.length;
    },

    async upsertIdentityReturnTarget(input) {
      const [row] = await db
        .insert(identityReturnTargets)
        .values({
          id: createId("irtg"),
          key: input.key,
          origin: input.origin,
          enabled: input.enabled,
        })
        .onConflictDoUpdate({
          target: identityReturnTargets.key,
          set: {
            origin: input.origin,
            enabled: input.enabled,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error("Failed to save Identity return target.");
      return returnTargetRow(row);
    },

    async listIdentityReturnTargets() {
      return (
        await db.select().from(identityReturnTargets).orderBy(asc(identityReturnTargets.createdAt))
      ).map(returnTargetRow);
    },

    async getIdentityReturnTargetByKey(key) {
      const [row] = await db
        .select()
        .from(identityReturnTargets)
        .where(eq(identityReturnTargets.key, key))
        .limit(1);
      return row ? returnTargetRow(row) : null;
    },

    async putIdentityOidcCredential(input) {
      const [row] = await db
        .insert(identityOidcCredentials)
        .values(input)
        .onConflictDoUpdate({
          target: [
            identityOidcCredentials.identityPrincipalId,
            identityOidcCredentials.providerConnectionId,
          ],
          set: {
            accessTokenEncrypted: input.accessTokenEncrypted,
            refreshTokenEncrypted: input.refreshTokenEncrypted,
            scope: input.scope,
            accessTokenExpiresAt: input.accessTokenExpiresAt,
            rotationSeq: 0,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error("Failed to save OIDC credential.");
      return oidcCredentialRow(row);
    },

    async getIdentityOidcCredential(identityPrincipalId, providerConnectionId) {
      const [row] = await db
        .select()
        .from(identityOidcCredentials)
        .where(
          and(
            eq(identityOidcCredentials.identityPrincipalId, identityPrincipalId),
            eq(identityOidcCredentials.providerConnectionId, providerConnectionId),
          ),
        )
        .limit(1);
      return row ? oidcCredentialRow(row) : null;
    },

    async rotateIdentityOidcCredential(input) {
      const [row] = await db
        .update(identityOidcCredentials)
        .set({
          accessTokenEncrypted: input.accessTokenEncrypted,
          refreshTokenEncrypted: input.refreshTokenEncrypted,
          scope: input.scope,
          accessTokenExpiresAt: input.accessTokenExpiresAt,
          rotationSeq: input.expectedRotationSeq + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(identityOidcCredentials.identityPrincipalId, input.identityPrincipalId),
            eq(identityOidcCredentials.providerConnectionId, input.providerConnectionId),
            eq(identityOidcCredentials.rotationSeq, input.expectedRotationSeq),
          ),
        )
        .returning();
      return row ? oidcCredentialRow(row) : null;
    },

    async createIdentitySigningKey(input) {
      return db.transaction(async (tx) => {
        if (input.status === "active") {
          await tx
            .update(identitySigningKeys)
            .set({ status: "retiring" })
            .where(eq(identitySigningKeys.status, "active"));
        }
        const [row] = await tx
          .insert(identitySigningKeys)
          .values({
            ...input,
            id: input.id ?? createId("isky"),
            publicJwk: input.publicJwk,
          })
          .returning();
        if (!row) throw new Error("Failed to create Identity signing key.");
        return signingKeyRow(row);
      });
    },

    async listIdentitySigningKeys() {
      return (
        await db.select().from(identitySigningKeys).orderBy(desc(identitySigningKeys.createdAt))
      ).map(signingKeyRow);
    },

    async getActiveIdentitySigningKey(now = new Date()) {
      const [row] = await db
        .select()
        .from(identitySigningKeys)
        .where(
          and(
            eq(identitySigningKeys.status, "active"),
            lt(identitySigningKeys.notBefore, now),
            gt(identitySigningKeys.expiresAt, now),
          ),
        )
        .limit(1);
      return row ? signingKeyRow(row) : null;
    },
  };
}

function providerValues(input: Parameters<IdentityStore["createIdentityProviderConnection"]>[0]) {
  if (input.type === "internal") {
    if (!input.internalRealmKey) throw new Error("Internal Realm key is required.");
    return {
      id: createId("idpc"),
      type: input.type,
      displayName: input.displayName,
      internalRealmKey: input.internalRealmKey,
      issuer: null,
      clientId: null,
      clientSecretEncrypted: null,
      scopes: [],
      authorizationParameters: {},
      tokenEndpointAuthMethod: null,
      externalRealmResolution: "internal_member",
      externalRealmClaim: null,
      enabled: input.enabled,
      securityRevision: 1,
    };
  }
  if (!input.issuer || !input.clientId || !input.tokenEndpointAuthMethod) {
    throw new Error("OIDC issuer, Client ID, and token endpoint authentication are required.");
  }
  return {
    id: createId("idpc"),
    type: input.type,
    displayName: input.displayName,
    internalRealmKey: null,
    issuer: input.issuer,
    clientId: input.clientId,
    clientSecretEncrypted: input.clientSecretEncrypted ?? null,
    scopes: input.scopes ?? [],
    authorizationParameters: input.authorizationParameters ?? {},
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
    externalRealmResolution: input.externalRealmResolution ?? "connection",
    externalRealmClaim: input.externalRealmClaim ?? null,
    enabled: input.enabled,
    securityRevision: 1,
  };
}

function providerRow(row: ProviderRow): IdentityProviderConnection {
  return {
    id: row.id,
    type: row.type as IdentityProviderConnection["type"],
    displayName: row.displayName,
    internalRealmKey: row.internalRealmKey,
    issuer: row.issuer,
    clientId: row.clientId,
    clientSecretEncrypted: row.clientSecretEncrypted,
    scopes: row.scopes as string[],
    authorizationParameters: row.authorizationParameters as Record<string, string>,
    tokenEndpointAuthMethod:
      row.tokenEndpointAuthMethod as IdentityProviderConnection["tokenEndpointAuthMethod"],
    externalRealmResolution:
      row.externalRealmResolution as IdentityProviderConnection["externalRealmResolution"],
    externalRealmClaim: row.externalRealmClaim,
    enabled: row.enabled,
    securityRevision: row.securityRevision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function realmRow(row: RealmRow): IdentityRealm {
  return {
    id: row.id,
    providerConnectionId: row.providerConnectionId,
    externalRealmId: row.externalRealmId,
    externalRealmKind: row.externalRealmKind as ExternalRealmKind,
    displayName: row.displayName,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function principalRow(row: PrincipalRow): IdentityPrincipal {
  return {
    id: row.id,
    identityRealmId: row.identityRealmId,
    externalSubject: row.externalSubject,
    displayName: row.displayName,
    email: row.email,
    claims: row.claims as IdentityPrincipal["claims"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sessionRow(row: SessionRow): IdentitySession {
  return {
    id: row.id,
    tokenHash: row.tokenHash,
    identityPrincipalId: row.identityPrincipalId,
    activeIdentityRealmId: row.activeIdentityRealmId,
    expiresAt: row.expiresAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function transactionRow(row: TransactionRow): IdentityLoginTransaction {
  return {
    stateHash: row.stateHash,
    providerConnectionId: row.providerConnectionId,
    providerSecurityRevision: row.providerSecurityRevision,
    returnTargetId: row.returnTargetId,
    returnPath: row.returnPath,
    nonceHash: row.nonceHash,
    pkceVerifierEncrypted: row.pkceVerifierEncrypted,
    expiresAt: row.expiresAt.toISOString(),
    consumedAt: row.consumedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function returnTargetRow(row: ReturnTargetRow): IdentityReturnTarget {
  return {
    id: row.id,
    key: row.key,
    origin: row.origin,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function oidcCredentialRow(row: OidcCredentialRow): IdentityOidcCredential {
  return {
    identityPrincipalId: row.identityPrincipalId,
    providerConnectionId: row.providerConnectionId,
    accessTokenEncrypted: row.accessTokenEncrypted,
    refreshTokenEncrypted: row.refreshTokenEncrypted,
    scope: row.scope,
    accessTokenExpiresAt: row.accessTokenExpiresAt?.toISOString() ?? null,
    rotationSeq: row.rotationSeq,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function signingKeyRow(row: SigningKeyRow): IdentitySigningKey {
  return {
    id: row.id,
    algorithm: row.algorithm as "ES256",
    publicJwk: row.publicJwk as Record<string, unknown>,
    privateKeyEncrypted: row.privateKeyEncrypted,
    status: row.status as IdentitySigningKeyStatus,
    notBefore: row.notBefore.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
