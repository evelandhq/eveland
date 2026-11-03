import type {
  ModelGatewayKind,
  ProjectModelGateway,
  ProjectModelGatewayMode,
} from "@evelandhq/core/model-gateway";

export type ProjectModelGatewayResponse = {
  settings: ProjectModelGateway;
  gateway: { kind: ModelGatewayKind; issuesProjectKeys: boolean } | null;
};

export type ModelGatewayKindOption = {
  value: ModelGatewayKind;
  label: string;
  description: string;
  credentialLabel: string;
  credentialDescription: string;
  baseUrlPlaceholder: string | null;
};

export const modelGatewayKindOptions: readonly ModelGatewayKindOption[] = [
  {
    value: "litellm",
    label: "LiteLLM",
    description: "Eveland issues each project its own key and records LiteLLM's reported cost.",
    credentialLabel: "Management key",
    credentialDescription:
      "A LiteLLM key allowed to create and delete keys. It stays inside Eveland and never reaches an Agent.",
    baseUrlPlaceholder: "https://llm.example.com/v1",
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    description: "Every project shares one key; OpenRouter's reported cost is recorded.",
    credentialLabel: "API key",
    credentialDescription: "Shared by every project that uses the platform Model Gateway.",
    baseUrlPlaceholder: "https://openrouter.ai/api/v1",
  },
  {
    value: "vercel",
    label: "Vercel AI Gateway",
    description: "Every project shares one AI Gateway key.",
    credentialLabel: "AI Gateway API key",
    credentialDescription: "Shared by every project that uses the platform Model Gateway.",
    baseUrlPlaceholder: null,
  },
  {
    value: "openai-compatible",
    label: "OpenAI-compatible",
    description:
      "Any Chat Completions endpoint. Every project shares one key; cost is not reported.",
    credentialLabel: "API key",
    credentialDescription: "Shared by every project that uses the platform Model Gateway.",
    baseUrlPlaceholder: "https://llm.example.com/v1",
  },
];

export function modelGatewayKindOption(kind: ModelGatewayKind): ModelGatewayKindOption {
  return modelGatewayKindOptions.find((option) => option.value === kind)!;
}

export type ModelGatewayDraft = { kind: ModelGatewayKind; baseUrl: string; credential: string };

export type ModelGatewayInput = { kind: ModelGatewayKind; baseUrl?: string; credential?: string };

/**
 * Mirrors the API's rules so the form can explain a problem before saving: a
 * credential may be left blank only to keep the stored one for the same
 * gateway, which the API also refuses to send anywhere else.
 */
export function validateModelGatewayDraft(
  draft: ModelGatewayDraft,
  existing: { kind: ModelGatewayKind; baseUrl: string | null } | null,
): { ok: true; input: ModelGatewayInput } | { ok: false; error: string } {
  const option = modelGatewayKindOption(draft.kind);
  const credential = draft.credential.trim();
  let baseUrl: string | undefined;
  if (option.baseUrlPlaceholder !== null) {
    baseUrl = draft.baseUrl.trim().replace(/\/+$/, "");
    if (!isHttpUrl(baseUrl)) {
      return {
        ok: false,
        error: "Enter the gateway's http(s) base URL, such as https://llm.example.com/v1.",
      };
    }
  }
  const sameGateway =
    existing !== null &&
    existing.kind === draft.kind &&
    (existing.baseUrl ?? undefined) === baseUrl;
  if (credential === "" && !sameGateway) {
    return { ok: false, error: `Enter the ${option.credentialLabel.toLowerCase()}.` };
  }
  return {
    ok: true,
    input: {
      kind: draft.kind,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(credential === "" ? {} : { credential }),
    },
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export const projectModelGatewayModeOptions: ReadonlyArray<{
  value: ProjectModelGatewayMode;
  label: string;
  description: string;
}> = [
  {
    value: "platform",
    label: "Platform key",
    description: "Use the key Eveland issues for this project, or the instance's shared key.",
  },
  {
    value: "project-key",
    label: "Project's own key",
    description: "Use a key this project obtained on the gateway itself.",
  },
  {
    value: "off",
    label: "Off",
    description: "Do not route this project's string model IDs through the platform gateway.",
  },
];

export function projectModelGatewayKeySummary(
  settings: Pick<ProjectModelGateway, "mode" | "issuedKey">,
  gateway: { kind: ModelGatewayKind; issuesProjectKeys: boolean } | null,
): string {
  if (gateway === null) return "No Model Gateway is configured; Agents call models as authored.";
  if (settings.mode === "off") return "Not using the platform Model Gateway.";
  if (settings.mode === "project-key") return "Using the project's own key.";
  if (!gateway.issuesProjectKeys) return "Using the instance's shared key.";
  if (settings.issuedKey?.state === "registered") {
    return `Using its own issued key, ${settings.issuedKey.alias}.`;
  }
  return "A key for this project is issued on its next deploy or restart.";
}
