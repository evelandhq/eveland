import { createHash, randomUUID } from "node:crypto";
import { verifyOidc } from "eve/channels/auth";
import * as oidc from "openid-client";
import type { Store } from "@eveland/db";
import {
  normalizeOidcAuthorizationCodeConfig,
  type OidcAuthorizationCodeConfig,
} from "./config.js";
import type {
  AgentAuthMethodRegistration,
  AgentConnectionSnapshot,
} from "./module.js";
import { openAgentAuthValue, sealAgentAuthValue } from "./sealed-value.js";

export type OidcAuthorizationTransaction = {
  state: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
};

export type OidcTokenResult = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  issuer: string;
  subject: string;
};

export type OidcProtocol = {
  preflight(config: OidcAuthorizationCodeConfig): Promise<void>;
  buildAuthorizationUrl(
    config: OidcAuthorizationCodeConfig,
    transaction: OidcAuthorizationTransaction,
  ): Promise<URL>;
  exchangeAuthorizationCode(
    config: OidcAuthorizationCodeConfig,
    input: OidcAuthorizationTransaction & { currentUrl: URL },
  ): Promise<OidcTokenResult>;
  refresh(config: OidcAuthorizationCodeConfig, refreshToken: string, subject: string): Promise<OidcTokenResult>;
};

type OidcTransactionPayload = OidcAuthorizationTransaction & {
  agentConnectionId: string;
  securityRevision: number;
  callerPrincipalId: string;
  authMethod: "oidc";
  returnPath: string;
};

type ActiveOidcCredentialPayload = {
  state: "active";
  accessToken: string;
  refreshToken?: string;
  agentIssuer: string;
  agentSubject: string;
  idTokenIssuer: string;
  idTokenSubject: string;
  obtainedAt: string;
};

type PendingOidcCredentialPayload = {
  state: "pending_verification";
  candidateAccessToken: string;
  refreshToken?: string;
  agentIssuer?: string;
  agentSubject?: string;
  idTokenIssuer: string;
  idTokenSubject: string;
  obtainedAt: string;
};

type OidcCredentialPayload = ActiveOidcCredentialPayload | PendingOidcCredentialPayload;

class OidcAccessTokenRejectedError extends Error {}
class OidcReauthorizationRequiredError extends Error {}

const CREDENTIAL_REFRESH_SKEW_MS = 30_000;

export type OidcAuthorizationCodeProvider = {
  callbackUrl: string;
  registration: AgentAuthMethodRegistration;
  preflight(config: OidcAuthorizationCodeConfig): Promise<void>;
  start(input: {
    connection: AgentConnectionSnapshot;
    callerPrincipalId: string;
    returnPath: string;
  }): Promise<{ state: string; authorizationUrl: string }>;
  callback(input: {
    state: string;
    currentUrl: URL;
    callerPrincipalId: string;
    getConnection(id: string): Promise<AgentConnectionSnapshot | null>;
  }): Promise<{ returnPath: string }>;
};

export function createOidcAuthorizationCodeProvider(options: {
  store: Store;
  appSecretKey: string;
  callbackUrl: string;
  protocol?: OidcProtocol;
  verifyAccessToken?: (
    accessToken: string,
    config: OidcAuthorizationCodeConfig,
    expected: { issuer: string; subject: string },
  ) => Promise<{ issuer: string; subject: string }>;
  allowInsecureIssuer?: boolean;
  now?: () => Date;
}): OidcAuthorizationCodeProvider {
  const protocol = options.protocol ?? createOpenIdClientProtocol({ allowInsecureIssuer: options.allowInsecureIssuer });
  const now = options.now ?? (() => new Date());
  const callbackUrl = new URL(options.callbackUrl).toString();
  const verifyAccessToken = options.verifyAccessToken ?? verifyAccessTokenWithEve;
  const refreshOwner = randomUUID();
  const refreshFlights = new Map<string, Promise<void>>();

  function openCredentialPayload(
    credential: Awaited<ReturnType<Store["getAgentAuthCredential"]>> & {},
    key: ReturnType<typeof credentialKey>,
  ): OidcCredentialPayload {
    return openAgentAuthValue<OidcCredentialPayload>(
      credential.payloadEncrypted,
      options.appSecretKey,
      "credential",
      credentialAad(key),
    );
  }

  function isCredentialExpiringSoon(
    credential: Awaited<ReturnType<Store["getAgentAuthCredential"]>> & {},
  ): boolean {
    return !credential.expiresAt || new Date(credential.expiresAt).getTime() <= now().getTime() + CREDENTIAL_REFRESH_SKEW_MS;
  }

  function getOrStartRefreshFlight(
    key: ReturnType<typeof credentialKey>,
    connection: AgentConnectionSnapshot,
    rawConfig: unknown,
    callerPrincipalId: string,
    credential: Awaited<ReturnType<Store["getAgentAuthCredential"]>> & {},
    payload: ActiveOidcCredentialPayload,
  ): Promise<void> {
    const flightKey = [key.agentConnectionId, key.securityRevision, key.scopeSubject, credential.rotationSeq].join(":");
    let flight = refreshFlights.get(flightKey);
    if (!flight) {
      const config = normalizeOidcAuthorizationCodeConfig(asRecord(rawConfig));
      flight = refreshCredential(connection, config, callerPrincipalId, credential, payload)
        .finally(() => refreshFlights.delete(flightKey));
      refreshFlights.set(flightKey, flight);
    }
    return flight;
  }

  async function refreshCredential(
    connection: AgentConnectionSnapshot,
    config: OidcAuthorizationCodeConfig,
    callerPrincipalId: string,
    credential: Awaited<ReturnType<Store["getAgentAuthCredential"]>> & {},
    payload: ActiveOidcCredentialPayload,
  ): Promise<void> {
    if (!payload.refreshToken) throw new Error("OIDC credential has no refresh token.");
    const key = credentialKey(connection, callerPrincipalId);
    const leaseId = randomUUID();
    const claimed = await options.store.claimAgentAuthCredentialRefresh({
      ...key,
      expectedRotationSeq: credential.rotationSeq,
      owner: refreshOwner,
      leaseId,
      leaseUntil: new Date(now().getTime() + 30_000),
      now: now(),
    });
    if (!claimed) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const current = await options.store.getAgentAuthCredential(key);
        if (current && current.rotationSeq > credential.rotationSeq) return;
      }
      throw new Error("Another Agent credential refresh is in progress.");
    }
    try {
      const token = await protocol.refresh(config, payload.refreshToken, payload.idTokenSubject);
      let nextPayload: OidcCredentialPayload;
      try {
        const verified = await verifyAccessToken(token.accessToken, config, { issuer: token.issuer, subject: token.subject });
        if (
          verified.issuer !== payload.agentIssuer
          || verified.subject !== payload.agentSubject
          || token.issuer !== payload.idTokenIssuer
          || token.subject !== payload.idTokenSubject
        ) {
          throw new OidcAccessTokenRejectedError("OIDC refresh changed the Agent identity.");
        }
        nextPayload = {
          state: "active",
          accessToken: token.accessToken,
          refreshToken: token.refreshToken ?? payload.refreshToken,
          agentIssuer: payload.agentIssuer,
          agentSubject: payload.agentSubject,
          idTokenIssuer: token.issuer,
          idTokenSubject: token.subject,
          obtainedAt: now().toISOString(),
        };
      } catch (error) {
        if (error instanceof OidcAccessTokenRejectedError) throw error;
        nextPayload = {
          state: "pending_verification",
          candidateAccessToken: token.accessToken,
          refreshToken: token.refreshToken ?? payload.refreshToken,
          agentIssuer: payload.agentIssuer,
          agentSubject: payload.agentSubject,
          idTokenIssuer: token.issuer,
          idTokenSubject: token.subject,
          obtainedAt: now().toISOString(),
        };
      }
      const completed = await options.store.completeAgentAuthCredentialRefresh({
        ...key,
        expectedRotationSeq: credential.rotationSeq,
        owner: refreshOwner,
        leaseId,
        payloadEncrypted: sealAgentAuthValue(
          nextPayload,
          options.appSecretKey,
          "credential",
          credentialAad(key),
        ),
        expiresAt: token.expiresAt,
      });
      if (!completed) throw new Error("Agent credential changed while refresh was in progress.");
    } catch (error) {
      await options.store.releaseAgentAuthCredentialRefresh({
        ...key,
        expectedRotationSeq: credential.rotationSeq,
        owner: refreshOwner,
        leaseId,
      });
      if (error instanceof oidc.ResponseBodyError && error.error === "invalid_grant") {
        await options.store.deleteAgentAuthCredential(key, credential.rotationSeq);
        throw new OidcReauthorizationRequiredError("OIDC refresh grant is no longer valid.");
      }
      throw error;
    }
  }

  const registration: AgentAuthMethodRegistration = {
    method: "oidc",
    credentialScope: "principal",
    authority: "canonical",
    async getCredential({ target, connection, config: rawConfig, interaction }) {
      const key = credentialKey(connection, target.callerPrincipalId);
      let credential = await options.store.getAgentAuthCredential(key);
      if (!credential) return interactionRequired(connection.id, interaction?.returnPath);
      let payload: OidcCredentialPayload;
      try {
        payload = openCredentialPayload(credential, key);
      } catch {
        return {
          code: "configuration_invalid",
          method: registration.method,
          message: "The stored Agent credential could not be decrypted.",
        };
      }
      if (payload.state === "pending_verification") {
        const config = normalizeOidcAuthorizationCodeConfig(asRecord(rawConfig));
        let verified: { issuer: string; subject: string };
        try {
          verified = await verifyAccessToken(payload.candidateAccessToken, config, {
            issuer: payload.idTokenIssuer,
            subject: payload.idTokenSubject,
          });
        } catch (error) {
          if (error instanceof OidcReauthorizationRequiredError) {
            return interactionRequired(connection.id, interaction?.returnPath);
          }
          if (error instanceof OidcAccessTokenRejectedError) {
            await options.store.deleteAgentAuthCredential(key, credential.rotationSeq);
            return {
              code: "configuration_invalid",
              method: registration.method,
              message: "The OIDC access token is not accepted by Eve's verifier.",
            };
          }
          return {
            code: "provider_unavailable",
            method: registration.method,
            message: "The OIDC access token could not be verified yet.",
          };
        }
        if (
          (payload.agentIssuer !== undefined && verified.issuer !== payload.agentIssuer)
          || (payload.agentSubject !== undefined && verified.subject !== payload.agentSubject)
        ) {
          await options.store.deleteAgentAuthCredential(key, credential.rotationSeq);
          return {
            code: "configuration_invalid",
            method: registration.method,
            message: "The OIDC access token changed the Agent identity.",
          };
        }
        const active: OidcCredentialPayload = {
          state: "active",
          accessToken: payload.candidateAccessToken,
          ...(payload.refreshToken ? { refreshToken: payload.refreshToken } : {}),
          agentIssuer: verified.issuer,
          agentSubject: verified.subject,
          idTokenIssuer: payload.idTokenIssuer,
          idTokenSubject: payload.idTokenSubject,
          obtainedAt: payload.obtainedAt,
        };
        const activated = await options.store.replaceAgentAuthCredential({
          ...key,
          expectedRotationSeq: credential.rotationSeq,
          payloadEncrypted: sealAgentAuthValue(
            active,
            options.appSecretKey,
            "credential",
            credentialAad(key),
          ),
          expiresAt: credential.expiresAt ? new Date(credential.expiresAt) : null,
        });
        if (!activated) {
          return {
            code: "retry_required",
            method: registration.method,
            message: "The Agent credential changed while verification was in progress.",
          };
        }
        credential = activated;
        payload = active;
      }
      if (isCredentialExpiringSoon(credential)) {
        if (!payload.refreshToken) return interactionRequired(connection.id, interaction?.returnPath);
        const flight = getOrStartRefreshFlight(key, connection, rawConfig, target.callerPrincipalId, credential, payload);
        try {
          await flight;
        } catch (error) {
          if (error instanceof OidcReauthorizationRequiredError) {
            return interactionRequired(connection.id, interaction?.returnPath);
          }
          if (error instanceof OidcAccessTokenRejectedError) {
            return {
              code: "configuration_invalid",
              method: registration.method,
              message: "The refreshed OIDC access token is not accepted by Eve's verifier.",
            };
          }
          return {
            code: "provider_unavailable",
            method: registration.method,
            message: "The identity provider could not refresh the Agent credential.",
          };
        }
        credential = await options.store.getAgentAuthCredential(key);
        if (!credential) return interactionRequired(connection.id, interaction?.returnPath);
        try {
          payload = openCredentialPayload(credential, key);
        } catch {
          return {
            code: "configuration_invalid",
            method: registration.method,
            message: "The refreshed Agent credential could not be decrypted.",
          };
        }
        if (payload.state === "pending_verification") {
          return {
            code: "provider_unavailable",
            method: registration.method,
            message: "The refreshed Agent credential is awaiting verification.",
          };
        }
        if (isCredentialExpiringSoon(credential)) {
          return interactionRequired(connection.id, interaction?.returnPath);
        }
      }
      return {
        credential: { kind: "headers", headers: [["authorization", `Bearer ${payload.accessToken}`]] },
        version: { securityRevision: connection.securityRevision, rotationSeq: credential.rotationSeq },
      };
    },
    async recoverUnauthorized({ target, connection, config: rawConfig, attempt, rejectedVersion }) {
      const key = credentialKey(connection, target.callerPrincipalId);
      const credential = await options.store.getAgentAuthCredential(key);
      if (!credential) {
        return { action: "give_up", failure: interactionRequired(connection.id) };
      }
      if (rejectedVersion.securityRevision !== connection.securityRevision || rejectedVersion.rotationSeq === null) {
        return {
          action: "give_up",
          failure: {
            code: "retry_required",
            method: registration.method,
            message: "The Agent Connection changed; retry the request.",
          },
        };
      }
      if (attempt === 1) {
        const deleted = await options.store.deleteAgentAuthCredential(key, rejectedVersion.rotationSeq);
        if (!deleted) {
          const current = await options.store.getAgentAuthCredential(key);
          if (current && current.rotationSeq > rejectedVersion.rotationSeq) {
            return {
              action: "give_up",
              failure: {
                code: "retry_required",
                method: registration.method,
                message: "A newer Agent credential was preserved; retry the request.",
              },
            };
          }
        }
        return { action: "give_up", failure: interactionRequired(connection.id) };
      }
      if (credential.rotationSeq > rejectedVersion.rotationSeq) return { action: "retry" };
      if (credential.rotationSeq !== rejectedVersion.rotationSeq) {
        return {
          action: "give_up",
          failure: {
            code: "retry_required",
            method: registration.method,
            message: "The Agent credential changed; retry the request.",
          },
        };
      }
      let payload: OidcCredentialPayload;
      try {
        payload = openCredentialPayload(credential, key);
      } catch {
        return {
          action: "give_up",
          failure: {
            code: "configuration_invalid",
            method: registration.method,
            message: "The stored Agent credential could not be decrypted.",
          },
        };
      }
      if (payload.state === "pending_verification") {
        return {
          action: "give_up",
          failure: {
            code: "provider_unavailable",
            method: registration.method,
            message: "The Agent credential is awaiting OIDC access-token verification.",
          },
        };
      }
      if (!payload.refreshToken) return { action: "give_up", failure: interactionRequired(connection.id) };
      const flight = getOrStartRefreshFlight(key, connection, rawConfig, target.callerPrincipalId, credential, payload);
      try {
        await flight;
        return { action: "retry" };
      } catch (error) {
        if (error instanceof OidcReauthorizationRequiredError) {
          return { action: "give_up", failure: interactionRequired(connection.id) };
        }
        if (error instanceof OidcAccessTokenRejectedError) {
          return {
            action: "give_up",
            failure: {
              code: "configuration_invalid",
              method: registration.method,
              message: "The refreshed OIDC access token is not accepted by Eve's verifier.",
            },
          };
        }
        return {
          action: "give_up",
          failure: {
            code: "provider_unavailable",
            method: registration.method,
            message: "The identity provider could not refresh the rejected Agent credential.",
          },
        };
      }
    },
    async inspect({ target, connection, interaction }) {
      const key = credentialKey(connection, target.callerPrincipalId);
      const credential = await options.store.getAgentAuthCredential(key);
      if (!credential) {
        const failure = interactionRequired(connection.id, interaction?.returnPath);
        return { state: "interaction_required", ...(failure.interaction ? { interaction: failure.interaction } : {}) };
      }
      try {
        const payload = openCredentialPayload(credential, key);
        if (payload.state === "pending_verification") return { state: "credential_available" };
        if (!isCredentialExpiringSoon(credential)) {
          return { state: "credential_available" };
        }
        if (payload.refreshToken) return { state: "credential_available" };
        const failure = interactionRequired(connection.id, interaction?.returnPath);
        return { state: "interaction_required", ...(failure.interaction ? { interaction: failure.interaction } : {}) };
      } catch {
        return { state: "misconfigured", message: "The stored Agent credential could not be decrypted." };
      }
    },
  };

  return {
    callbackUrl,
    registration,
    async preflight(config) {
      assertOidcIssuer(config.issuer, options.allowInsecureIssuer === true);
      await protocol.preflight(config);
    },
    async start(input) {
      const config = normalizeOidcAuthorizationCodeConfig(asRecord(input.connection.config));
      assertReturnPath(input.returnPath, input.connection.target.projectId);
      await this.preflight(config);
      const state = oidc.randomState();
      const transaction: OidcTransactionPayload = {
        state,
        codeVerifier: oidc.randomPKCECodeVerifier(),
        nonce: oidc.randomNonce(),
        redirectUri: callbackUrl,
        agentConnectionId: input.connection.id,
        securityRevision: input.connection.securityRevision,
        callerPrincipalId: input.callerPrincipalId,
        authMethod: "oidc",
        returnPath: input.returnPath,
      };
      const stateHash = hashState(state);
      await options.store.createAgentAuthTransaction({
        agentConnectionId: input.connection.id,
        stateHash,
        payloadEncrypted: sealAgentAuthValue(transaction, options.appSecretKey, "transaction", [stateHash]),
        expiresAt: new Date(now().getTime() + 10 * 60_000),
      });
      const authorizationUrl = await protocol.buildAuthorizationUrl(config, transaction);
      return { state, authorizationUrl: authorizationUrl.toString() };
    },
    async callback(input) {
      const stateHash = hashState(input.state);
      const stored = await options.store.consumeAgentAuthTransaction(stateHash, now());
      if (!stored) throw new Error("OIDC authorization transaction is invalid, expired, or already used.");
      const transaction = openAgentAuthValue<OidcTransactionPayload>(
        stored.payloadEncrypted,
        options.appSecretKey,
        "transaction",
        [stateHash],
      );
      if (transaction.state !== input.state) throw new Error("OIDC authorization state does not match.");
      if (transaction.callerPrincipalId !== input.callerPrincipalId) throw new Error("OIDC authorization belongs to a different caller.");
      const connection = await input.getConnection(transaction.agentConnectionId);
      if (
        !connection
        || connection.method !== transaction.authMethod
        || connection.securityRevision !== transaction.securityRevision
      ) {
        throw new Error("Agent Connection changed while OIDC authorization was in progress.");
      }
      const config = normalizeOidcAuthorizationCodeConfig(asRecord(connection.config));
      const token = await protocol.exchangeAuthorizationCode(config, {
        state: transaction.state,
        codeVerifier: transaction.codeVerifier,
        nonce: transaction.nonce,
        redirectUri: transaction.redirectUri,
        currentUrl: input.currentUrl,
      });
      const key = credentialKey(connection, input.callerPrincipalId);
      let payload: OidcCredentialPayload;
      try {
        const verified = await verifyAccessToken(token.accessToken, config, { issuer: token.issuer, subject: token.subject });
        payload = {
          state: "active",
          accessToken: token.accessToken,
          ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
          agentIssuer: verified.issuer,
          agentSubject: verified.subject,
          idTokenIssuer: token.issuer,
          idTokenSubject: token.subject,
          obtainedAt: now().toISOString(),
        };
      } catch (error) {
        if (error instanceof OidcAccessTokenRejectedError) throw error;
        payload = {
          state: "pending_verification",
          candidateAccessToken: token.accessToken,
          ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
          idTokenIssuer: token.issuer,
          idTokenSubject: token.subject,
          obtainedAt: now().toISOString(),
        };
      }
      await options.store.putAgentAuthCredential({
        ...key,
        payloadEncrypted: sealAgentAuthValue(
          payload,
          options.appSecretKey,
          "credential",
          credentialAad(key),
        ),
        expiresAt: token.expiresAt,
      });
      return { returnPath: transaction.returnPath };
    },
  };
}

function credentialKey(connection: AgentConnectionSnapshot, callerPrincipalId: string) {
  return {
    agentConnectionId: connection.id,
    securityRevision: connection.securityRevision,
    authMethod: connection.method,
    credentialScope: "principal" as const,
    scopeSubject: callerPrincipalId,
    credentialKey: "",
  };
}

function credentialAad(key: ReturnType<typeof credentialKey>): readonly unknown[] {
  return [
    key.agentConnectionId,
    key.securityRevision,
    key.authMethod,
    key.credentialScope,
    key.scopeSubject,
    key.credentialKey,
  ];
}

function interactionRequired(agentConnectionId: string, returnPath?: string) {
  return {
    code: "interaction_required" as const,
    method: "oidc",
    message: "Authorize this Agent Connection before sending a message.",
    ...(returnPath ? {
      interaction: {
        type: "redirect" as const,
        url: `/api/eveland/agent-connections/${encodeURIComponent(agentConnectionId)}/auth/interactions/oidc/start?returnPath=${encodeURIComponent(returnPath)}`,
      },
    } : {}),
  };
}

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("OIDC configuration is invalid.");
  return value as Record<string, unknown>;
}

function assertReturnPath(returnPath: string, projectId: string): void {
  const expected = `/projects/${projectId}/playground`;
  if (returnPath !== expected && !returnPath.startsWith(`${expected}?`)) throw new Error("OIDC return path is not allowed.");
}

function assertOidcIssuer(value: string, allowInsecure: boolean): void {
  const issuer = new URL(value);
  if (issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error("OIDC issuer must not contain userinfo, query, or fragment components.");
  if (issuer.protocol !== "https:" && !(allowInsecure && issuer.protocol === "http:")) {
    throw new Error("OIDC issuer must use HTTPS.");
  }
}

async function verifyAccessTokenWithEve(
  accessToken: string,
  config: OidcAuthorizationCodeConfig,
  _expected: { issuer: string; subject: string },
): Promise<{ issuer: string; subject: string }> {
  const result = await verifyOidc(accessToken, { issuer: config.issuer, audiences: [config.audience] });
  if (!result.ok) throw new OidcAccessTokenRejectedError("OIDC access token is not accepted by Eve's OIDC verifier.");
  return {
    issuer: result.sessionAuth.issuer ?? config.issuer,
    subject: result.sessionAuth.subject ?? result.sessionAuth.principalId,
  };
}

function createOpenIdClientProtocol(options: { allowInsecureIssuer?: boolean }): OidcProtocol {
  const cache = new Map<string, Promise<oidc.Configuration>>();
  const getConfiguration = (config: OidcAuthorizationCodeConfig) => {
    const key = JSON.stringify(config);
    let pending = cache.get(key);
    if (!pending) {
      const clientAuth = config.tokenEndpointAuthMethod === "client_secret_basic"
        ? oidc.ClientSecretBasic(config.clientSecret)
        : config.tokenEndpointAuthMethod === "client_secret_post"
          ? oidc.ClientSecretPost(config.clientSecret)
          : oidc.None();
      pending = oidc.discovery(
        new URL(config.issuer),
        config.clientId,
        {
          ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
          token_endpoint_auth_method: config.tokenEndpointAuthMethod,
        },
        clientAuth,
        {
          timeout: 10,
          ...(options.allowInsecureIssuer ? { execute: [oidc.allowInsecureRequests] } : {}),
        },
      );
      cache.set(key, pending);
      void pending.catch(() => {
        if (cache.get(key) === pending) cache.delete(key);
      });
    }
    return pending;
  };
  const audienceParameters = (config: OidcAuthorizationCodeConfig) => ({
    ...(config.audienceMode === "resource" || config.audienceMode === "both" ? { resource: config.audience } : {}),
    ...(config.audienceMode === "audience" || config.audienceMode === "both" ? { audience: config.audience } : {}),
  });

  return {
    async preflight(config) {
      await getConfiguration(config);
    },
    async buildAuthorizationUrl(config, transaction) {
      const configuration = await getConfiguration(config);
      return oidc.buildAuthorizationUrl(configuration, {
        redirect_uri: transaction.redirectUri,
        response_type: "code",
        scope: config.scopes.join(" "),
        state: transaction.state,
        nonce: transaction.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(transaction.codeVerifier),
        code_challenge_method: "S256",
        ...(config.promptConsent ? { prompt: "consent" } : {}),
        ...audienceParameters(config),
      });
    },
    async exchangeAuthorizationCode(config, input) {
      const configuration = await getConfiguration(config);
      const tokens = await oidc.authorizationCodeGrant(
        configuration,
        input.currentUrl,
        {
          pkceCodeVerifier: input.codeVerifier,
          expectedState: input.state,
          expectedNonce: input.nonce,
          idTokenExpected: true,
        },
        audienceParameters(config),
      );
      const claims = tokens.claims();
      if (!tokens.access_token || !claims?.sub || !claims.iss) throw new Error("OIDC token response is missing an access token or ID token identity.");
      return {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        expiresAt: new Date(Date.now() + (tokens.expires_in ?? 300) * 1000),
        issuer: claims.iss,
        subject: claims.sub,
      };
    },
    async refresh(config, refreshToken, subject) {
      const configuration = await getConfiguration(config);
      const tokens = await oidc.refreshTokenGrant(configuration, refreshToken, audienceParameters(config));
      if (!tokens.access_token) throw new Error("OIDC refresh response is missing an access token.");
      const claims = tokens.claims();
      if (claims?.sub && claims.sub !== subject) throw new Error("OIDC refresh changed the Agent subject.");
      return {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        expiresAt: new Date(Date.now() + (tokens.expires_in ?? 300) * 1000),
        issuer: claims?.iss ?? config.issuer,
        subject,
      };
    },
  };
}
