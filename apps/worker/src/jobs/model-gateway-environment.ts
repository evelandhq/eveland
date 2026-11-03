import type { Store } from "@evelandhq/db";
import { MODEL_GATEWAY_ENV } from "@evelandhq/core/model-gateway";

/**
 * Resolves the reserved EVELAND_MODEL_GATEWAY_KIND/URL variables for one
 * project's launch: where the injected default provider sends string model
 * IDs.
 *
 * Both names are always reserved -- empty when the instance has no Model
 * Gateway or the project opted out -- so a project entry can never point the
 * injected provider at a gateway of its own choosing. The key is not
 * Eveland's: it is the project's own AI_GATEWAY_API_KEY, and Eveland never
 * supplies one.
 */

export type ModelGatewayEnvironmentStore = Pick<
  Store,
  "getModelGateway" | "getProjectModelGateway"
>;

export type ModelGatewayEnvironment = Record<(typeof MODEL_GATEWAY_ENV)["kind" | "url"], string>;

export async function resolveModelGatewayEnvironment(
  store: ModelGatewayEnvironmentStore,
  projectId: string,
): Promise<ModelGatewayEnvironment> {
  const [gateway, setting] = await Promise.all([
    store.getModelGateway(),
    store.getProjectModelGateway(projectId),
  ]);
  const active = gateway !== null && setting.mode === "platform";
  return {
    [MODEL_GATEWAY_ENV.kind]: active ? gateway.kind : "",
    [MODEL_GATEWAY_ENV.url]: active ? (gateway.baseUrl ?? "") : "",
  };
}
