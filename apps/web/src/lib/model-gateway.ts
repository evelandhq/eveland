import {
  MODEL_GATEWAY_ENV,
  type ModelGatewayKind,
  type ProjectModelGateway,
  type ProjectModelGatewayMode,
} from "@evelandhq/core/model-gateway";

export type ProjectModelGatewayResponse = {
  settings: ProjectModelGateway;
  gateway: { kind: ModelGatewayKind; baseUrl: string } | null;
};

export type ModelGatewayKindOption = {
  value: ModelGatewayKind;
  label: string;
  description: string;
  baseUrlPlaceholder: string;
};

export const modelGatewayKindOptions: readonly ModelGatewayKindOption[] = [
  {
    value: "litellm",
    label: "LiteLLM",
    description: "LiteLLM's reported cost is recorded.",
    baseUrlPlaceholder: "https://llm.example.com/v1",
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    description: "OpenRouter's reported cost is recorded.",
    baseUrlPlaceholder: "https://openrouter.ai/api/v1",
  },
  {
    value: "openai-compatible",
    label: "OpenAI-compatible",
    description: "Any Chat Completions endpoint. Cost is not reported.",
    baseUrlPlaceholder: "https://llm.example.com/v1",
  },
];

export function modelGatewayKindOption(kind: ModelGatewayKind): ModelGatewayKindOption {
  return modelGatewayKindOptions.find((option) => option.value === kind)!;
}

export type ModelGatewayInput = { kind: ModelGatewayKind; baseUrl: string };

/** Mirrors the API's rules so the form can explain a problem before saving. */
export function validateModelGatewayDraft(
  draft: ModelGatewayInput,
): { ok: true; input: ModelGatewayInput } | { ok: false; error: string } {
  const baseUrl = trimTrailingSlashes(draft.baseUrl.trim());
  if (!isHttpUrl(baseUrl)) {
    return {
      ok: false,
      error: "Enter the gateway's http(s) base URL, such as https://llm.example.com/v1.",
    };
  }
  return { ok: true, input: { kind: draft.kind, baseUrl } };
}

/** The connection test: the form's gateway, plus a key that is sent once and never saved. */
export function validateModelGatewayTest(
  draft: ModelGatewayInput,
  key: string,
): { ok: true; input: ModelGatewayInput & { key: string } } | { ok: false; error: string } {
  const validated = validateModelGatewayDraft(draft);
  if (!validated.ok) return validated;
  if (key.trim() === "") return { ok: false, error: "Enter a key to test the gateway with." };
  return { ok: true, input: { ...validated.input, key: key.trim() } };
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

export const projectModelGatewayModeOptions: ReadonlyArray<{
  value: ProjectModelGatewayMode;
  label: string;
  description: string;
}> = [
  {
    value: "platform",
    label: "Use the Model Gateway",
    description: `String model IDs go to the instance's gateway with this project's ${MODEL_GATEWAY_ENV.key}.`,
  },
  {
    value: "off",
    label: "Off",
    description: "Agents call models as authored, as if no Model Gateway were configured.",
  },
];

export function projectModelGatewaySummary(
  settings: Pick<ProjectModelGateway, "mode">,
  gateway: ProjectModelGatewayResponse["gateway"],
): string {
  if (gateway === null) return "No Model Gateway is configured; Agents call models as authored.";
  if (settings.mode === "off") {
    return "Not using the Model Gateway; Agents call models as authored.";
  }
  return `String model IDs go to ${modelGatewayKindOption(gateway.kind).label} at ${gateway.baseUrl} with this project's ${MODEL_GATEWAY_ENV.key}.`;
}
