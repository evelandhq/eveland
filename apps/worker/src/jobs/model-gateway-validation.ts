import { MODEL_GATEWAY_ENV } from "@evelandhq/core/model-gateway";
import { listGatewayModelIds } from "@evelandhq/core/server/model-gateway-client";

/**
 * Deploy-time check that the gateway offers every model the Agent names.
 *
 * Static model IDs come from eve's compiled agent manifest (the root agent's
 * and every declared subagent's `config.model.id`); a dynamically selected
 * model cannot be known before it runs and is not checked. The list is asked
 * for with the project's own key, so a per-key model restriction on the
 * gateway counts too.
 *
 * A model the gateway explicitly does not offer fails the deploy with the
 * closest IDs it does offer. A gateway that cannot list its models only warns:
 * the list is a reference rather than a fact Eveland can prove, and a model
 * call that then fails says so on its own.
 */

const VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

export type ModelGatewayValidationResult =
  | { status: "skipped" }
  | { status: "ok"; checked: string[] }
  | { status: "missing"; missing: Array<{ id: string; suggestions: string[] }> }
  | { status: "unavailable"; error: string };

export async function validateModelGatewayModels(input: {
  env: Readonly<Record<string, string>>;
  modelIds: readonly string[];
  listModels?: (input: { baseUrl: string; apiKey: string }) => Promise<string[]>;
}): Promise<ModelGatewayValidationResult> {
  const kind = input.env[MODEL_GATEWAY_ENV.kind];
  if (!kind || input.modelIds.length === 0) return { status: "skipped" };
  const baseUrl = kind === "vercel" ? VERCEL_AI_GATEWAY_BASE_URL : input.env[MODEL_GATEWAY_ENV.url];
  const apiKey = input.env[MODEL_GATEWAY_ENV.key];
  if (!baseUrl || !apiKey) return { status: "skipped" };

  let offered: string[];
  try {
    offered = await (input.listModels ?? listGatewayModelIds)({ baseUrl, apiKey });
  } catch (error) {
    return { status: "unavailable", error: error instanceof Error ? error.message : String(error) };
  }
  const available = new Set(offered);
  const missing = input.modelIds
    .filter((id) => !available.has(id))
    .map((id) => ({ id, suggestions: closestIds(id, offered) }));
  return missing.length === 0
    ? { status: "ok", checked: [...input.modelIds] }
    : { status: "missing", missing };
}

export function modelGatewayValidationLog(result: ModelGatewayValidationResult): string[] {
  switch (result.status) {
    case "skipped":
      return [];
    case "ok":
      return [`Model Gateway offers the Agent's models: ${result.checked.join(", ")}`];
    case "unavailable":
      return [
        `WARNING: could not check the Agent's models against the Model Gateway (${result.error}); deploying anyway.`,
      ];
    case "missing":
      return result.missing.map(
        ({ id, suggestions }) =>
          `ERROR: model ${id} is not offered by the Model Gateway to this project's key${
            suggestions.length > 0 ? `; did you mean ${suggestions.join(", ")}?` : "."
          } Add it (or an alias with this name) on the gateway, or change the Agent's model.`,
      );
  }
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
