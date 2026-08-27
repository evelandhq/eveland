import { hashModelGatewayToken } from "@evelandhq/core/server/model-gateway-token";

/**
 * Narrow persistence port of the model gateway's token check — the full Store
 * satisfies it structurally, the app never sees more than this.
 */
export type ModelGatewayTokenRepository = {
  findLiveRuntimeInstanceByModelGatewayTokenHash(tokenHash: string): Promise<{
    runtimeInstanceId: string;
    deploymentId: string;
    projectId: string;
  } | null>;
};

/**
 * Authenticates `AI_GATEWAY_API_KEY` bearer tokens against RuntimeInstance
 * rows: a token is valid exactly while the instance it was minted for is
 * live. No revocation bookkeeping — the instance lifecycle is the revocation.
 */
export type ModelGatewayAuthResult = false | { subject: string };

export function createInstanceTokenAuthenticator(
  repository: ModelGatewayTokenRepository,
): (token: string) => Promise<ModelGatewayAuthResult> {
  return async (token) => {
    if (!token.startsWith("emg_")) return false;
    const resolved = await repository.findLiveRuntimeInstanceByModelGatewayTokenHash(
      hashModelGatewayToken(token),
    );
    return resolved === null ? false : { subject: `project:${resolved.projectId}` };
  };
}

export type ModelGatewayApiKeyRepository = {
  findActiveModelGatewayApiKeyByHash(
    tokenHash: string,
  ): Promise<{ id: string; userId: string } | null>;
};

/**
 * The gateway's full caller surface: instance-bound runtime tokens (emg_,
 * minted by the Worker per RuntimeInstance) and member-minted personal API
 * keys (emk_, revoked by timestamp). Anything else is rejected without a
 * lookup.
 */
export function createModelGatewayAuthenticator(
  repository: ModelGatewayTokenRepository & ModelGatewayApiKeyRepository,
): (token: string) => Promise<ModelGatewayAuthResult> {
  const authenticateInstanceToken = createInstanceTokenAuthenticator(repository);
  return async (token) => {
    if (token.startsWith("emg_")) return authenticateInstanceToken(token);
    if (token.startsWith("emk_")) {
      const key = await repository.findActiveModelGatewayApiKeyByHash(hashModelGatewayToken(token));
      return key === null ? false : { subject: `user:${key.userId}` };
    }
    return false;
  };
}
