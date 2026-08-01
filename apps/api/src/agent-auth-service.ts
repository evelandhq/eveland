import {
  createAgentAuthRegistry,
  type AgentAuthProviderRegistration,
  type AgentCredentialContext,
} from "@eveland/agent-auth";
import {
  createOidcAgentAuthProvider,
  type OidcAuthorizationCodePersistence,
  type OidcAuthorizationCodeProviderOptions,
  type OidcProtocol,
} from "@eveland/agent-auth/oidc";
import {
  openAgentAuthConfig,
  sealAgentAuthConfig,
} from "@eveland/agent-auth/sealed-config";
import type { AgentAuthSecretReference } from "@eveland/core/agent-auth";
import type { AgentConnection } from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import {
  decryptSecretValue,
  type EncryptedSecret,
} from "@eveland/core/server/secrets";
import type { AgentAuthStore, SecretStore } from "@eveland/db";

export type AgentAuthServiceStore = OidcAuthorizationCodePersistence &
  Pick<
    AgentAuthStore,
    | "createAgentConnection"
    | "getAgentConnection"
    | "getProjectAgentConnection"
  > &
  Pick<SecretStore, "listSecretRecords">;

export type AgentAuthServiceOptions = {
  store: AgentAuthServiceStore;
  appSecretKey: string;
  oidcCallbackUrl: string;
  agentAuthProviders?: AgentAuthProviderRegistration[];
  oidcProtocol?: OidcProtocol;
  oidcVerifyAccessToken?: OidcAuthorizationCodeProviderOptions["verifyAccessToken"];
  agentAuthNow?: () => Date;
};

export function createAgentAuthService(options: AgentAuthServiceOptions) {
  const {
    store,
    appSecretKey,
    oidcCallbackUrl,
    agentAuthProviders = [],
  } = options;

  const ensureProjectAgentConnection = async (
    projectId: string,
  ): Promise<AgentConnection> => {
    const existing = await store.getProjectAgentConnection(projectId);
    if (existing) return existing;
    const id = createId("acon");
    return store.createAgentConnection({
      id,
      target: { kind: "managed-project", projectId },
      method: "local-dev",
      configEncrypted: sealAgentAuthConfig({}, appSecretKey, {
        agentConnectionId: id,
        method: "local-dev",
        securityRevision: 1,
      }),
    });
  };

  const readConnectionConfig = (connection: AgentConnection): unknown =>
    openAgentAuthConfig(connection.configEncrypted, appSecretKey, {
      agentConnectionId: connection.id,
      method: connection.method,
      securityRevision: connection.securityRevision,
    });

  const sealConnectionConfig = (
    config: unknown,
    connection: Pick<
      AgentConnection,
      "id" | "method" | "securityRevision"
    >,
  ): string =>
    sealAgentAuthConfig(config, appSecretKey, {
      agentConnectionId: connection.id,
      method: connection.method,
      securityRevision: connection.securityRevision,
    });

  const resolveAgentAuthSecret = async (
    projectId: string,
    reference: AgentAuthSecretReference,
  ): Promise<string> => {
    const encryptedValue = (await store.listSecretRecords(projectId)).find(
      (secret) => secret.key === reference.key,
    )?.encryptedValue;
    if (!encryptedValue) {
      throw new Error(
        "The configured Playground authentication secret reference is unavailable.",
      );
    }
    try {
      return decryptSecretValue(
        JSON.parse(encryptedValue) as EncryptedSecret,
        appSecretKey,
      );
    } catch {
      throw new Error(
        "The configured Playground authentication secret reference cannot be decrypted.",
      );
    }
  };

  const oidcRegistration = createOidcAgentAuthProvider({
    store,
    appSecretKey,
    callbackUrl: oidcCallbackUrl,
    resolveClientSecret: async (config, connection) => {
      if (!config.clientSecretRef) return undefined;
      return resolveAgentAuthSecret(
        connection.target.projectId,
        config.clientSecretRef,
      );
    },
    ...(options.oidcProtocol ? { protocol: options.oidcProtocol } : {}),
    ...(options.oidcVerifyAccessToken
      ? { verifyAccessToken: options.oidcVerifyAccessToken }
      : {}),
    ...(options.agentAuthNow ? { now: options.agentAuthNow } : {}),
    getConnection: async (connectionId) => {
      const connection = await store.getAgentConnection(connectionId);
      return connection
        ? { ...connection, config: readConnectionConfig(connection) }
        : null;
    },
  });
  const registry = createAgentAuthRegistry([
    oidcRegistration,
    ...agentAuthProviders,
  ]);

  const credentialContext = (
    connection: AgentConnection,
    callerPrincipalId: string,
    returnPath?: string,
  ): AgentCredentialContext => ({
    connection: {
      ...connection,
      config: readConnectionConfig(connection),
    },
    callerPrincipalId,
    ...(returnPath ? { returnPath } : {}),
    resolveSecret: (reference) =>
      resolveAgentAuthSecret(connection.target.projectId, reference),
  });

  const publicConnection = async (
    connection: AgentConnection,
    callerPrincipalId?: string,
  ) => {
    const provider = registry.get(connection.method);
    if (!provider) {
      return {
        connection: {
          ...connection,
          configEncrypted: undefined,
          config: {},
        },
        status: {
          state: "misconfigured" as const,
          message: `Unsupported Playground authentication method: ${connection.method}.`,
        },
      };
    }
    try {
      const context = credentialContext(
        connection,
        callerPrincipalId ?? "",
        `/projects/${connection.target.projectId}/playground`,
      );
      const config = context.connection.config;
      const { configEncrypted: _configEncrypted, ...safe } = connection;
      if (provider.descriptor.interactive && callerPrincipalId) {
        const resolved = await provider.getCredential(context);
        return {
          connection: { ...safe, config: provider.redactConfig(config) },
          status:
            "failure" in resolved
              ? resolved.failure.code === "interaction_required"
                ? {
                    state: "interaction_required" as const,
                    ...(resolved.failure.interaction
                      ? { interaction: resolved.failure.interaction }
                      : {}),
                  }
                : {
                    state: "misconfigured" as const,
                    message: resolved.failure.message,
                  }
              : { state: "credential_available" as const },
        };
      }
      return {
        connection: { ...safe, config: provider.redactConfig(config) },
        status: {
          state: provider.descriptor.interactive
            ? ("interaction_required" as const)
            : provider.method === "local-dev" || provider.method === "none"
              ? ("not_required" as const)
              : ("credential_available" as const),
        },
      };
    } catch {
      const { configEncrypted: _configEncrypted, ...safe } = connection;
      return {
        connection: { ...safe, config: provider.redactConfig({}) },
        status: {
          state: "misconfigured" as const,
          message:
            "The stored Playground authentication configuration cannot be decrypted.",
        },
      };
    }
  };

  const resolveProjectAgentAuthCredential = async (
    projectId: string,
    callerPrincipalId: string,
  ) => {
    const connection = await ensureProjectAgentConnection(projectId);
    const provider = registry.get(connection.method);
    if (!provider) {
      throw new Error(
        `Unsupported Playground authentication method: ${connection.method}.`,
      );
    }
    const context = credentialContext(
      connection,
      callerPrincipalId,
      `/projects/${projectId}/playground`,
    );
    return {
      connection,
      provider,
      context,
      resolution: await provider.getCredential(context),
    };
  };

  const resolveCurrentAgentAuthCredential = async (
    connectionId: string,
    expectedMethod: string,
    callerPrincipalId: string,
    returnPath: string,
  ) => {
    const connection = await store.getAgentConnection(connectionId);
    if (!connection || connection.method !== expectedMethod) return null;
    const provider = registry.get(connection.method);
    if (!provider) return null;
    const context = credentialContext(
      connection,
      callerPrincipalId,
      returnPath,
    );
    return {
      context,
      resolution: await provider.getCredential(context),
    };
  };

  return {
    registry,
    credentialContext,
    ensureProjectAgentConnection,
    publicConnection,
    readConnectionConfig,
    resolveAgentAuthSecret,
    resolveCurrentAgentAuthCredential,
    resolveProjectAgentAuthCredential,
    sealConnectionConfig,
  };
}

export type AgentAuthService = ReturnType<typeof createAgentAuthService>;
