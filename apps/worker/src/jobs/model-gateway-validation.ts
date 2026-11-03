import { MODEL_GATEWAY_ENV } from "@evelandhq/core/model-gateway";
import {
  ModelGatewayRequestError,
  listGatewayModelIds,
} from "@evelandhq/core/server/model-gateway-client";

/**
 * Deploy-time check that the gateway accepts the project's key and offers
 * every model the Agent names.
 *
 * Static model IDs come from eve's compiled agent manifest (the root agent's
 * and every declared subagent's `config.model.id`); a dynamically selected
 * model cannot be known before it runs and is not checked. The list is asked
 * for with the project's own AI_GATEWAY_API_KEY, so a per-key model
 * restriction on the gateway counts too.
 *
 * Fails the deploy: a key the gateway rejects (HTTP 401), and a model the
 * gateway explicitly does not offer (with the closest IDs it does offer).
 * Only warns: a project with no key -- Eveland never supplies one, and the
 * model call then fails on its own -- and a gateway that cannot list its
 * models, since the list is a reference rather than a fact Eveland can prove.
 * Every outcome names the gateway's address.
 */

export type ModelGatewayValidationResult =
  | { status: "skipped" }
  | { status: "ok"; checked: string[] }
  | { status: "no-key"; baseUrl: string }
  | { status: "rejected"; baseUrl: string }
  | { status: "missing"; baseUrl: string; missing: Array<{ id: string; suggestions: string[] }> }
  | { status: "unavailable"; baseUrl: string; error: string };

export async function validateModelGatewayModels(input: {
  env: Readonly<Record<string, string>>;
  modelIds: readonly string[];
  listModels?: (input: { baseUrl: string; apiKey: string }) => Promise<string[]>;
}): Promise<ModelGatewayValidationResult> {
  const kind = input.env[MODEL_GATEWAY_ENV.kind];
  const baseUrl = input.env[MODEL_GATEWAY_ENV.url];
  if (!kind || !baseUrl || input.modelIds.length === 0) return { status: "skipped" };
  const apiKey = input.env[MODEL_GATEWAY_ENV.key]?.trim();
  if (!apiKey) return { status: "no-key", baseUrl };

  let offered: string[];
  try {
    offered = await (input.listModels ?? listGatewayModelIds)({ baseUrl, apiKey });
  } catch (error) {
    if (error instanceof ModelGatewayRequestError && error.status === 401) {
      return { status: "rejected", baseUrl };
    }
    return {
      status: "unavailable",
      baseUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const available = new Set(offered);
  const missing = input.modelIds
    .filter((id) => !available.has(id))
    .map((id) => ({ id, suggestions: closestIds(id, offered) }));
  return missing.length === 0
    ? { status: "ok", checked: [...input.modelIds] }
    : { status: "missing", baseUrl, missing };
}

/** Whether the result must fail the deploy before anything is recorded or started. */
export function modelGatewayValidationFails(
  result: ModelGatewayValidationResult,
): result is Extract<ModelGatewayValidationResult, { status: "rejected" | "missing" }> {
  return result.status === "rejected" || result.status === "missing";
}

export function modelGatewayValidationLog(result: ModelGatewayValidationResult): string[] {
  switch (result.status) {
    case "skipped":
      return [];
    case "ok":
      return [`Model Gateway offers the Agent's models: ${result.checked.join(", ")}`];
    case "no-key":
      return [
        `WARNING: ${MODEL_GATEWAY_ENV.key} is not set, so model calls to the Model Gateway at ${result.baseUrl} will fail. Set it in the project's environment.`,
      ];
    case "rejected":
      return [
        `ERROR: the Model Gateway at ${result.baseUrl} rejected this project's ${MODEL_GATEWAY_ENV.key} (HTTP 401). Set a key issued by that gateway, or opt the project out of the Model Gateway.`,
      ];
    case "unavailable":
      return [
        `WARNING: could not check the Agent's models against the Model Gateway at ${result.baseUrl} (${result.error}); deploying anyway.`,
      ];
    case "missing":
      return result.missing.map(
        ({ id, suggestions }) =>
          `ERROR: model ${id} is not offered by the Model Gateway at ${result.baseUrl} to this project's key${
            suggestions.length > 0 ? `; did you mean ${suggestions.join(", ")}?` : "."
          } Add it (or an alias with this name) on the gateway, or change the Agent's model.`,
      );
  }
}

/** The deploy failure for a result that fails it; the build log has the detail. */
export function modelGatewayValidationError(
  result: Extract<ModelGatewayValidationResult, { status: "rejected" | "missing" }>,
): Error {
  return new Error(
    result.status === "rejected"
      ? `The Model Gateway at ${result.baseUrl} rejected this project's ${MODEL_GATEWAY_ENV.key}. See the build log.`
      : `The Model Gateway at ${result.baseUrl} does not offer ${result.missing.map(({ id }) => id).join(", ")} to this project. See the build log.`,
  );
}

function closestIds(id: string, offered: readonly string[]): string[] {
  const normalized = normalize(id);
  return offered
    .map((candidate) => ({ candidate, distance: editDistance(normalized, normalize(candidate)) }))
    .filter(({ distance }) => distance <= Math.max(2, Math.floor(normalized.length / 8)))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

function normalize(id: string): string {
  return id.toLowerCase().replace(/[._-]/g, "");
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j]!;
      previous[j] = Math.min(
        above + 1,
        previous[j - 1]! + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length]!;
}
