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
export function createInstanceTokenAuthenticator(
  repository: ModelGatewayTokenRepository,
): (token: string) => Promise<boolean> {
  return async (token) => {
    if (!token.startsWith("emg_")) return false;
    const resolved = await repository.findLiveRuntimeInstanceByModelGatewayTokenHash(
      hashModelGatewayToken(token),
    );
    return resolved !== null;
  };
}
