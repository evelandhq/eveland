import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { AgentConnection, AgentAuthCredential } from "@eveland/core/contracts";
import type { Store } from "@eveland/db";
import { verifyOidc } from "eve/channels/auth";
import * as oidc from "openid-client";
import { sealAgentAuthCredential, openAgentAuthCredential, type AgentAuthCredentialBinding } from "./sealed-credential.js";
import {
  createOidcProviderDefinition,
  type AgentAuthConnectionSnapshot,
  type AgentAuthFailure,
  type AgentAuthProviderRegistration,
  type OidcAuthorizationCodeConfig,
} from "./registry.js";

export type OidcConnectionSnapshot = AgentConnection & { config: OidcAuthorizationCodeConfig };

export type OidcTransaction = {
  state: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
  agentConnectionId: string;
  securityRevision: number;
  callerPrincipalId: string;
  authMethod: "oidc";
  returnPath: string;
};

export type OidcTokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  issuer: string;
  subject: string;
};

export type OidcProtocol = {
  preflight(config: OidcAuthorizationCodeConfig, clientSecret?: string): Promise<void>;
  buildAuthorizationUrl(
    config: OidcAuthorizationCodeConfig,
    clientSecret: string | undefined,
    transaction: OidcTransaction,
  ): Promise<URL>;
  exchangeAuthorizationCode(
    config: OidcAuthorizationCodeConfig,
    clientSecret: string | undefined,
    transaction: OidcTransaction,
    currentUrl: URL,
  ): Promise<OidcTokenSet>;
  refresh(
    config: OidcAuthorizationCodeConfig,
    clientSecret: string | undefined,
    refreshToken: string,
    subject: string,
  ): Promise<OidcTokenSet>;
  fetchUserInfo(
    config: OidcAuthorizationCodeConfig,
    clientSecret: string | undefined,
    accessToken: string,
    expectedSubject: string,
  ): Promise<{ subject: string }>;
};

export type OidcCredentialResolution =
  | {
      envelope: { version: 1; authority: "canonical"; headers: [["authorization", string]] };
      version: { securityRevision: number; rotationSeq: number };
    }
  | { failure: AgentAuthFailure };

type ActiveCredential = {
  state: "active";
  accessToken: string;
  refreshToken?: string;
  agentIssuer: string;
  agentSubject: string;
  idTokenIssuer: string;
  idTokenSubject: string;
  obtainedAt: string;
};

type PendingCredential = {
  state: "pending_verification";
  candidateAccessToken: string;
  refreshToken?: string;
  idTokenIssuer: string;
  idTokenSubject: string;
  obtainedAt: string;
};

type CredentialPayload = ActiveCredential | PendingCredential;

export class OidcAccessTokenRejectedError extends Error {}
export class OidcReauthorizationRequiredError extends Error {}

export type OidcAuthorizationCodeProviderOptions = {
  store: Store;
  appSecretKey: string;
  callbackUrl: string;
  resolveClientSecret(config: OidcAuthorizationCodeConfig, connection: OidcConnectionSnapshot): Promise<string | undefined>;
  protocol?: OidcProtocol;
  verifyAccessToken?: (
    accessToken: string,
    config: OidcAuthorizationCodeConfig,
    expected: { issuer: string; subject: string },
    clientSecret?: string,
  ) => Promise<{ issuer: string; subject: string }>;
  now?: () => Date;
  refreshLeaseMs?: number;
  refreshWaitMs?: number;
  allowInsecureIssuer?: boolean;
};

export function createOidcAuthorizationCodeProvider(options: OidcAuthorizationCodeProviderOptions) {
  const now = options.now ?? (() => new Date());
  const protocol = options.protocol ?? createOpenIdClientProtocol({ allowInsecureIssuer: options.allowInsecureIssuer });
  const owner = `oidc-${randomUUID()}`;
  const refreshFlights = new Map<string, Promise<void>>();
  const verifyAccessToken = options.verifyAccessToken ?? (async (accessToken, config, expected, clientSecret) => {
    if (config.accessTokenVerification === "userinfo") {
      let result: { subject: string };
      try {
        result = await protocol.fetchUserInfo(config, clientSecret, accessToken, expected.subject);
      } catch (error) {
        const rejection = classifyUserInfoRejection(error);
        if (rejection) throw new OidcAccessTokenRejectedError(rejection);
        throw error;
      }
      if (result.subject !== expected.subject) {
        throw new OidcAccessTokenRejectedError("OIDC UserInfo subject does not match the verified ID token subject.");
      }
      return { issuer: config.issuer, subject: result.subject };
    }
    if (!config.audience) throw new OidcAccessTokenRejectedError("OIDC JWT verification requires an audience.");
    const result = await verifyOidc(accessToken, { issuer: config.issuer, audiences: [config.audience] });
    if (!result.ok) throw new OidcAccessTokenRejectedError("OIDC access token is not accepted by Eve's verifier.");
    return {
      issuer: result.sessionAuth.issuer ?? config.issuer,
      subject: result.sessionAuth.subject ?? result.sessionAuth.principalId,
    };
  });

  const openPayload = (credential: AgentAuthCredential, key: AgentAuthCredentialBinding): CredentialPayload =>
    openAgentAuthCredential(credential.payloadEncrypted, options.appSecretKey, key) as CredentialPayload;

  const verifyCandidate = async (
    token: OidcTokenSet,
    config: OidcAuthorizationCodeConfig,
    clientSecret: string | undefined,
  ): Promise<CredentialPayload> => {
    try {
      const verified = await verifyAccessToken(token.accessToken, config, { issuer: token.issuer, subject: token.subject }, clientSecret);
      return {
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
      return {
        state: "pending_verification",
        candidateAccessToken: token.accessToken,
        ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
        idTokenIssuer: token.issuer,
        idTokenSubject: token.subject,
        obtainedAt: now().toISOString(),
      };
    }
  };

  const keyFor = (connection: OidcConnectionSnapshot, callerPrincipalId: string): AgentAuthCredentialBinding => ({
    agentConnectionId: connection.id,
    securityRevision: connection.securityRevision,
    authMethod: "oidc",
    credentialScope: "principal",
    scopeSubject: callerPrincipalId,
    credentialKey: "",
  });

  const interactionRequired = (connectionId: string, returnPath?: string): AgentAuthFailure => ({
    code: "interaction_required",
    method: "oidc",
    message: "Authorize this Agent Connection before sending a message.",
    ...(returnPath ? {
      interaction: {
        type: "redirect",
        url: `/api/eveland/agent-connections/${encodeURIComponent(connectionId)}/auth/interactions/oidc/start?returnPath=${encodeURIComponent(returnPath)}`,
      },
    } : {}),
  });

  const waitForRefreshWinner = async (key: AgentAuthCredentialBinding, rejectedRotationSeq: number): Promise<void> => {
    const deadline = Date.now() + (options.refreshWaitMs ?? 35_000);
    while (Date.now() < deadline) {
      const current = await options.store.getAgentAuthCredential(key);
      if (!current) throw new OidcReauthorizationRequiredError();
      if (current.rotationSeq > rejectedRotationSeq) return;
      if (!current.refreshLeaseUntil || new Date(current.refreshLeaseUntil).getTime() <= now().getTime()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for another Eveland instance to refresh the OIDC credential.");
  };

  const refreshCredential = async (
    connection: OidcConnectionSnapshot,
    callerPrincipalId: string,
    credential: AgentAuthCredential,
    payload: CredentialPayload,
  ): Promise<void> => {
    const key = keyFor(connection, callerPrincipalId);
    const leaseId = randomUUID();
    const claimed = await options.store.claimAgentAuthCredentialRefresh({
      ...key,
      expectedRotationSeq: credential.rotationSeq,
      owner,
      leaseId,
      now: now(),
      leaseUntil: new Date(now().getTime() + (options.refreshLeaseMs ?? 30_000)),
    });
    if (!claimed) {
      await waitForRefreshWinner(key, credential.rotationSeq);
      return;
    }
    try {
      if (!payload.refreshToken) throw new OidcReauthorizationRequiredError();
      const clientSecret = await options.resolveClientSecret(connection.config, connection);
      const token = await protocol.refresh(connection.config, clientSecret, payload.refreshToken, payload.idTokenSubject);
      const nextPayload = await verifyCandidate(token, connection.config, clientSecret);
      const completed = await options.store.completeAgentAuthCredentialRefresh({
        ...key,
        expectedRotationSeq: credential.rotationSeq,
        owner,
        leaseId,
        now: now(),
        payloadEncrypted: sealAgentAuthCredential(nextPayload, options.appSecretKey, key),
        expiresAt: token.expiresAt,
      });
      if (!completed) await waitForRefreshWinner(key, credential.rotationSeq);
    } catch (error) {
      const released = await options.store.releaseAgentAuthCredentialRefresh({
        ...key,
        expectedRotationSeq: credential.rotationSeq,
        owner,
        leaseId,
        now: now(),
      });
      if (isInvalidGrant(error) && released) {
        await options.store.deleteAgentAuthCredential(key, credential.rotationSeq);
        throw new OidcReauthorizationRequiredError();
      }
      throw error;
    }
  };

  const getOrStartRefresh = (
    connection: OidcConnectionSnapshot,
    callerPrincipalId: string,
    credential: AgentAuthCredential,
    payload: CredentialPayload,
  ) => {
    const flightKey = JSON.stringify([connection.id, connection.securityRevision, callerPrincipalId]);
    let flight = refreshFlights.get(flightKey);
    if (!flight) {
      flight = refreshCredential(connection, callerPrincipalId, credential, payload);
      refreshFlights.set(flightKey, flight);
      void flight.finally(() => {
        if (refreshFlights.get(flightKey) === flight) refreshFlights.delete(flightKey);
      }).catch(() => undefined);
    }
    return flight;
  };

  const provider = {
    callbackUrl: options.callbackUrl,
    async preflight(connection: OidcConnectionSnapshot) {
      const clientSecret = await options.resolveClientSecret(connection.config, connection);
      await protocol.preflight(connection.config, clientSecret);
    },
    async start(input: { connection: OidcConnectionSnapshot; callerPrincipalId: string; returnPath: string }) {
      assertReturnPath(input.returnPath, input.connection.target.projectId);
      await provider.preflight(input.connection);
      await options.store.deleteExpiredAgentAuthTransactions(now(), 100);
      const state = oidc.randomState();
      const transaction: OidcTransaction = {
        state,
        codeVerifier: oidc.randomPKCECodeVerifier(),
        nonce: oidc.randomNonce(),
        redirectUri: options.callbackUrl,
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
        payloadEncrypted: sealTransaction(transaction, options.appSecretKey, stateHash),
        expiresAt: new Date(now().getTime() + 10 * 60_000),
      });
      const clientSecret = await options.resolveClientSecret(input.connection.config, input.connection);
      const authorizationUrl = await protocol.buildAuthorizationUrl(input.connection.config, clientSecret, transaction);
      return { state, authorizationUrl: authorizationUrl.toString() };
    },
    async callback(input: {
      state: string;
      currentUrl: URL;
      callerPrincipalId: string;
      getConnection(id: string): Promise<OidcConnectionSnapshot | null>;
    }) {
      const stateHash = hashState(input.state);
      const stored = await options.store.consumeAgentAuthTransaction(stateHash, now());
      if (!stored) throw new Error("OIDC authorization transaction is invalid, expired, or already used.");
      const transaction = openTransaction(stored.payloadEncrypted, options.appSecretKey, stateHash);
      if (transaction.state !== input.state) throw new Error("OIDC authorization state does not match.");
      if (transaction.callerPrincipalId !== input.callerPrincipalId) throw new Error("OIDC authorization belongs to a different caller.");
      const connection = await input.getConnection(transaction.agentConnectionId);
      if (!connection || connection.method !== "oidc" || connection.securityRevision !== transaction.securityRevision) {
        throw new Error("Agent Connection changed while OIDC authorization was in progress.");
      }
      const clientSecret = await options.resolveClientSecret(connection.config, connection);
      const token = await protocol.exchangeAuthorizationCode(connection.config, clientSecret, transaction, input.currentUrl);
      const payload = await verifyCandidate(token, connection.config, clientSecret);
      const currentConnection = await input.getConnection(transaction.agentConnectionId);
      if (!currentConnection || currentConnection.method !== "oidc" || currentConnection.securityRevision !== transaction.securityRevision) {
        throw new Error("Agent Connection changed while OIDC authorization was in progress.");
      }
      const key = keyFor(connection, input.callerPrincipalId);
      await options.store.putAgentAuthCredential({
        ...key,
        payloadEncrypted: sealAgentAuthCredential(payload, options.appSecretKey, key),
        expiresAt: token.expiresAt,
      });
      return { returnPath: transaction.returnPath };
    },
    async getCredential(input: {
      connection: OidcConnectionSnapshot;
      callerPrincipalId: string;
      returnPath?: string;
    }): Promise<OidcCredentialResolution> {
      const key = keyFor(input.connection, input.callerPrincipalId);
      let credential = await options.store.getAgentAuthCredential(key);
      if (!credential) return { failure: interactionRequired(input.connection.id, input.returnPath) };
      let payload: CredentialPayload;
      try {
        payload = openPayload(credential, key);
      } catch {
        return { failure: { code: "configuration_invalid", method: "oidc", message: "The stored Agent credential could not be decrypted." } };
      }
      if (payload.state === "pending_verification") {
        const clientSecret = await options.resolveClientSecret(input.connection.config, input.connection);
        try {
          const verified = await verifyAccessToken(
            payload.candidateAccessToken,
            input.connection.config,
            { issuer: payload.idTokenIssuer, subject: payload.idTokenSubject },
            clientSecret,
          );
          const active: ActiveCredential = {
            state: "active",
            accessToken: payload.candidateAccessToken,
            ...(payload.refreshToken ? { refreshToken: payload.refreshToken } : {}),
            agentIssuer: verified.issuer,
            agentSubject: verified.subject,
            idTokenIssuer: payload.idTokenIssuer,
            idTokenSubject: payload.idTokenSubject,
            obtainedAt: payload.obtainedAt,
          };
          const replaced = await options.store.replaceAgentAuthCredential({
            ...key,
            expectedRotationSeq: credential.rotationSeq,
            payloadEncrypted: sealAgentAuthCredential(active, options.appSecretKey, key),
            expiresAt: credential.expiresAt ? new Date(credential.expiresAt) : null,
          });
          if (!replaced) return provider.getCredential(input);
          credential = replaced;
          payload = active;
        } catch (error) {
          return { failure: {
            code: error instanceof OidcAccessTokenRejectedError ? "configuration_invalid" : "provider_unavailable",
            method: "oidc",
            message: error instanceof OidcAccessTokenRejectedError
              ? error.message
              : "The OIDC access token is awaiting verification.",
          } };
        }
      }
      if (isExpiringSoon(credential, now())) {
        if (!payload.refreshToken) return { failure: interactionRequired(input.connection.id, input.returnPath) };
        try {
          await getOrStartRefresh(input.connection, input.callerPrincipalId, credential, payload);
        } catch (error) {
          if (error instanceof OidcReauthorizationRequiredError) {
            return { failure: interactionRequired(input.connection.id, input.returnPath) };
          }
          if (error instanceof OidcAccessTokenRejectedError) {
            return { failure: { code: "configuration_invalid", method: "oidc", message: error.message } };
          }
          return { failure: { code: "provider_unavailable", method: "oidc", message: "The identity provider could not refresh the Agent credential." } };
        }
        return provider.getCredential(input);
      }
      return {
        envelope: { version: 1, authority: "canonical", headers: [["authorization", `Bearer ${payload.accessToken}`]] },
        version: { securityRevision: input.connection.securityRevision, rotationSeq: credential.rotationSeq },
      };
    },
    async recoverUnauthorized(input: {
      connection: OidcConnectionSnapshot;
      callerPrincipalId: string;
      rejectedVersion: { securityRevision: number; rotationSeq: number };
      attempt: 0 | 1;
      returnPath?: string;
    }): Promise<{ action: "retry" } | { action: "give_up"; failure: AgentAuthFailure }> {
      const key = keyFor(input.connection, input.callerPrincipalId);
      if (input.rejectedVersion.securityRevision !== input.connection.securityRevision) {
        return { action: "give_up", failure: { code: "retry_required", method: "oidc", message: "The Agent Connection changed; retry the request." } };
      }
      const credential = await options.store.getAgentAuthCredential(key);
      if (!credential) return { action: "give_up", failure: interactionRequired(input.connection.id, input.returnPath) };
      if (credential.rotationSeq > input.rejectedVersion.rotationSeq) return { action: "retry" };
      if (credential.rotationSeq !== input.rejectedVersion.rotationSeq) {
        return { action: "give_up", failure: { code: "retry_required", method: "oidc", message: "The Agent credential changed; retry the request." } };
      }
      if (input.attempt === 1) {
        await options.store.deleteAgentAuthCredential(key, credential.rotationSeq);
        return { action: "give_up", failure: interactionRequired(input.connection.id, input.returnPath) };
      }
      let payload: CredentialPayload;
      try {
        payload = openPayload(credential, key);
      } catch {
        return { action: "give_up", failure: { code: "configuration_invalid", method: "oidc", message: "The stored Agent credential could not be decrypted." } };
      }
      if (!payload.refreshToken) return { action: "give_up", failure: interactionRequired(input.connection.id, input.returnPath) };
      try {
        await getOrStartRefresh(input.connection, input.callerPrincipalId, credential, payload);
        return { action: "retry" };
      } catch (error) {
        return {
          action: "give_up",
          failure: error instanceof OidcReauthorizationRequiredError
            ? interactionRequired(input.connection.id, input.returnPath)
            : error instanceof OidcAccessTokenRejectedError
              ? { code: "configuration_invalid", method: "oidc", message: error.message }
            : { code: "provider_unavailable", method: "oidc", message: "The identity provider could not refresh the rejected Agent credential." },
        };
      }
    },
    interactionRequired,
  };
  return provider;
}

export function createOidcAgentAuthProvider(
  options: OidcAuthorizationCodeProviderOptions & {
    getConnection(id: string): Promise<AgentAuthConnectionSnapshot | null>;
  },
): AgentAuthProviderRegistration {
  const runtime = createOidcAuthorizationCodeProvider(options);
  const connection = (snapshot: AgentAuthConnectionSnapshot): OidcConnectionSnapshot => {
    if (snapshot.method !== "oidc") throw new Error("OIDC Agent Connection is not available.");
    return snapshot as OidcConnectionSnapshot;
  };
  return {
    ...createOidcProviderDefinition(),
    async preflight(context) {
      await runtime.preflight(connection(context.connection));
    },
    async getCredential(context) {
      return runtime.getCredential({
        connection: connection(context.connection),
        callerPrincipalId: context.callerPrincipalId,
        ...(context.returnPath ? { returnPath: context.returnPath } : {}),
      });
    },
    async recoverUnauthorized(context) {
      if (!isOidcCredentialVersion(context.rejectedVersion)) {
        return {
          action: "give_up",
          failure: {
            code: "retry_required",
            method: "oidc",
            message: "The Agent credential version is invalid; retry the request.",
          },
        };
      }
      return runtime.recoverUnauthorized({
        connection: connection(context.connection),
        callerPrincipalId: context.callerPrincipalId,
        rejectedVersion: context.rejectedVersion,
        attempt: context.attempt,
        ...(context.returnPath ? { returnPath: context.returnPath } : {}),
      });
    },
    interaction: {
      async start(context) {
        const result = await runtime.start({
          connection: connection(context.connection),
          callerPrincipalId: context.callerPrincipalId,
          returnPath: context.returnPath,
        });
        return { authorizationUrl: result.authorizationUrl };
      },
      async callback(context) {
        const callbackUrl = new URL(runtime.callbackUrl);
        callbackUrl.search = context.search;
        const state = callbackUrl.searchParams.get("state");
        if (!state) throw new Error("OIDC state is required.");
        return runtime.callback({
          state,
          currentUrl: callbackUrl,
          callerPrincipalId: context.callerPrincipalId,
          getConnection: async (connectionId) => {
            const snapshot = await options.getConnection(connectionId);
            return snapshot ? connection(snapshot) : null;
          },
        });
      },
    },
  };
}

export function createOpenIdClientProtocol(options: { allowInsecureIssuer?: boolean } = {}): OidcProtocol {
  const cache = new Map<string, Promise<oidc.Configuration>>();
  const getConfiguration = (config: OidcAuthorizationCodeConfig, clientSecret?: string) => {
    const secretFingerprint = clientSecret
      ? createHash("sha256").update(clientSecret).digest("base64url")
      : null;
    const key = JSON.stringify([config, secretFingerprint]);
    let pending = cache.get(key);
    if (!pending) {
      assertOidcUrl(new URL(config.issuer), options.allowInsecureIssuer === true);
      const clientAuth = config.tokenEndpointAuthMethod === "client_secret_basic"
        ? oidc.ClientSecretBasic(clientSecret)
        : config.tokenEndpointAuthMethod === "client_secret_post"
          ? oidc.ClientSecretPost(clientSecret)
          : oidc.None();
      pending = oidc.discovery(
        new URL(config.issuer),
        config.clientId,
        { token_endpoint_auth_method: config.tokenEndpointAuthMethod },
        clientAuth,
        {
          timeout: 10,
          // Defense in depth: openid-client v6 happens not to follow
          // redirects during discovery, but that is its internal behavior,
          // not a contract. Pinning the hardened fetch here makes the
          // no-redirect/per-URL-assertion policy explicit for the one request
          // a hostile issuer most directly controls, and the accompanying
          // test fails if a library upgrade ever starts following redirects.
          [oidc.customFetch]: safeOidcFetch(options.allowInsecureIssuer === true),
          ...(options.allowInsecureIssuer ? { execute: [oidc.allowInsecureRequests] } : {}),
        },
      ).then((configuration) => {
        validateDiscoveredEndpoints(configuration, options.allowInsecureIssuer === true);
        configuration[oidc.customFetch] = safeOidcFetch(options.allowInsecureIssuer === true);
        return configuration;
      });
      cache.set(key, pending);
      void pending.catch(() => {
        if (cache.get(key) === pending) cache.delete(key);
      });
    }
    return pending;
  };
  const audienceParams = (config: OidcAuthorizationCodeConfig) => {
    if (!config.audience) return {};
    return {
      ...(config.audienceMode === "resource" || config.audienceMode === "both" ? { resource: config.audience } : {}),
      ...(config.audienceMode === "audience" || config.audienceMode === "both" ? { audience: config.audience } : {}),
    };
  };
  return {
    async preflight(config, secret) { await getConfiguration(config, secret); },
    async buildAuthorizationUrl(config, secret, transaction) {
      const configuration = await getConfiguration(config, secret);
      return oidc.buildAuthorizationUrl(configuration, {
        redirect_uri: transaction.redirectUri,
        response_type: "code",
        scope: config.scopes.join(" "),
        state: transaction.state,
        nonce: transaction.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(transaction.codeVerifier),
        code_challenge_method: "S256",
        ...config.authorizationParams,
        ...audienceParams(config),
      });
    },
    async exchangeAuthorizationCode(config, secret, transaction, currentUrl) {
      const configuration = await getConfiguration(config, secret);
      const tokens = await oidc.authorizationCodeGrant(configuration, currentUrl, {
        pkceCodeVerifier: transaction.codeVerifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      }, audienceParams(config));
      const claims = tokens.claims();
      if (!tokens.access_token || !claims?.iss || !claims.sub) throw new Error("OIDC token response is missing an access token or verified ID token identity.");
      return {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        expiresAt: new Date(Date.now() + (tokens.expires_in ?? 300) * 1000),
        issuer: claims.iss,
        subject: claims.sub,
      };
    },
    async refresh(config, secret, refreshToken, subject) {
      const tokens = await oidc.refreshTokenGrant(await getConfiguration(config, secret), refreshToken, audienceParams(config));
      if (!tokens.access_token) throw new Error("OIDC refresh response is missing an access token.");
      const claims = tokens.claims();
      if (claims?.sub && claims.sub !== subject) throw new OidcAccessTokenRejectedError("OIDC refresh changed the authorized subject.");
      return {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        expiresAt: new Date(Date.now() + (tokens.expires_in ?? 300) * 1000),
        issuer: claims?.iss ?? config.issuer,
        subject,
      };
    },
    async fetchUserInfo(config, secret, accessToken, expectedSubject) {
      const result = await oidc.fetchUserInfo(await getConfiguration(config, secret), accessToken, expectedSubject);
      return { subject: result.sub };
    },
  };
}

function isExpiringSoon(credential: AgentAuthCredential, now: Date): boolean {
  return credential.expiresAt !== null && new Date(credential.expiresAt).getTime() <= now.getTime() + 30_000;
}

function isOidcCredentialVersion(value: unknown): value is { securityRevision: number; rotationSeq: number } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { securityRevision?: unknown }).securityRevision === "number"
    && typeof (value as { rotationSeq?: unknown }).rotationSeq === "number";
}

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function assertReturnPath(returnPath: string, projectId: string): void {
  const expected = `/projects/${projectId}/playground`;
  if (returnPath !== expected && !returnPath.startsWith(`${expected}?`)) throw new Error("OIDC return path is not allowed.");
}

function sealTransaction(transaction: OidcTransaction, appSecretKey: string, stateHash: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", transactionKey(appSecretKey), iv);
  cipher.setAAD(Buffer.from(JSON.stringify(["transaction", stateHash])));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(transaction), "utf8"), cipher.final()]);
  return JSON.stringify({
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

function openTransaction(value: string, appSecretKey: string, stateHash: string): OidcTransaction {
  const parsed = JSON.parse(value) as { version?: unknown; algorithm?: unknown; iv?: unknown; authTag?: unknown; ciphertext?: unknown };
  if (parsed.version !== 1 || parsed.algorithm !== "aes-256-gcm" || typeof parsed.iv !== "string" || typeof parsed.authTag !== "string" || typeof parsed.ciphertext !== "string") {
    throw new Error("Invalid sealed OIDC transaction.");
  }
  const decipher = createDecipheriv("aes-256-gcm", transactionKey(appSecretKey), Buffer.from(parsed.iv, "base64"));
  decipher.setAAD(Buffer.from(JSON.stringify(["transaction", stateHash])));
  decipher.setAuthTag(Buffer.from(parsed.authTag, "base64"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8")) as OidcTransaction;
}

function transactionKey(appSecretKey: string): Buffer {
  const utf8 = Buffer.from(appSecretKey, "utf8");
  const normalized = utf8.length === 32 ? utf8 : Buffer.from(appSecretKey, "base64");
  if (normalized.length !== 32) throw new Error("APP_SECRET_KEY must be 32 bytes or a base64 encoded 32-byte value.");
  return createHmac("sha256", normalized).update("eveland:agent-auth:transaction:v1").digest();
}

function validateDiscoveredEndpoints(configuration: oidc.Configuration, allowInsecure: boolean): void {
  const metadata = configuration.serverMetadata();
  for (const candidate of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.userinfo_endpoint,
    metadata.jwks_uri,
  ]) {
    if (candidate) assertOidcUrl(new URL(candidate), allowInsecure);
  }
}

function assertOidcUrl(url: URL, allowInsecure: boolean): void {
  if (url.username || url.password || url.hash) throw new Error("OIDC URLs must not contain userinfo or fragments.");
  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) throw new Error("OIDC URLs must use HTTPS.");
  const hostname = url.hostname.toLowerCase();
  if (!allowInsecure && (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || isPrivateIp(hostname))) {
    throw new Error("OIDC URLs must not target loopback or private network addresses.");
  }
}

function isPrivateIp(hostname: string): boolean {
  if (isIP(hostname) === 4) {
    return /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(hostname);
  }
  if (isIP(hostname) === 6) {
    return hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:");
  }
  return false;
}

function isInvalidGrant(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { error?: unknown; code?: unknown; cause?: { error?: unknown } };
  return candidate.error === "invalid_grant"
    || candidate.code === "invalid_grant"
    || candidate.cause?.error === "invalid_grant";
}

function classifyUserInfoRejection(error: unknown): string | null {
  if (error instanceof oidc.WWWAuthenticateChallengeError) {
    return "The identity provider rejected the access token at the UserInfo endpoint.";
  }
  if (error instanceof oidc.ClientError) {
    if (error.code === "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED") {
      return "The UserInfo subject does not match the verified ID token subject.";
    }
    if (error.code === "OAUTH_MISSING_SERVER_METADATA" || error.code === "OAUTH_INVALID_SERVER_METADATA") {
      return "The identity provider does not advertise a valid UserInfo endpoint.";
    }
  }
  if (typeof error === "object" && error !== null && "code" in error
    && (error.code === "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED"
      || error.code === "OAUTH_MISSING_SERVER_METADATA"
      || error.code === "OAUTH_INVALID_SERVER_METADATA")) {
    return error.code === "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED"
      ? "The UserInfo subject does not match the verified ID token subject."
      : "The identity provider does not advertise a valid UserInfo endpoint.";
  }
  return null;
}

function safeOidcFetch(allowInsecure: boolean): oidc.CustomFetch {
  return async (url, init) => {
    assertOidcUrl(new URL(url), allowInsecure);
    return fetch(url, { ...init, body: init.body as BodyInit, redirect: "error" });
  };
}
