/**
 * Model Gateway contract shared by the API, Worker, and Dashboard.
 *
 * A Model Gateway is the gateway Agents' LLM calls go through (Vercel AI
 * Gateway, OpenRouter, LiteLLM, or a generic OpenAI-compatible endpoint),
 * distinct from Eveland's own Agent Gateway. The runtime half of the contract
 * -- the provider an Agent process installs -- is the published
 * `eveland/model-gateway` module, which reads the same three reserved
 * variables named here. The Worker's injection tests bundle that module and
 * drive it with these names, so the two sides cannot drift apart silently.
 *
 * Browser-safe: no Node imports.
 */

export const MODEL_GATEWAY_KINDS = [
  "vercel",
  "openrouter",
  "litellm",
  "openai-compatible",
] as const;

export type ModelGatewayKind = (typeof MODEL_GATEWAY_KINDS)[number];

export function isModelGatewayKind(value: unknown): value is ModelGatewayKind {
  return typeof value === "string" && (MODEL_GATEWAY_KINDS as readonly string[]).includes(value);
}

/** Kinds whose gateway can issue one key per project. */
export const MODEL_GATEWAY_KEY_ISSUING_KINDS: readonly ModelGatewayKind[] = ["litellm"];

export function modelGatewayIssuesProjectKeys(kind: ModelGatewayKind): boolean {
  return MODEL_GATEWAY_KEY_ISSUING_KINDS.includes(kind);
}

/** Kinds that take a base URL. AI Gateway's address is fixed by Vercel. */
export function modelGatewayNeedsBaseUrl(kind: ModelGatewayKind): boolean {
  return kind !== "vercel";
}

/** The reserved runtime variables the injected provider reads. */
export const MODEL_GATEWAY_ENV = {
  kind: "EVELAND_MODEL_GATEWAY_KIND",
  url: "EVELAND_MODEL_GATEWAY_URL",
  key: "EVELAND_MODEL_GATEWAY_KEY",
} as const;

/**
 * How a project uses the instance's Model Gateway:
 * - `platform`: the key Eveland issues for the project, or the instance's
 *   shared key for a kind that cannot issue keys;
 * - `project-key`: a key the project supplies as its own secret;
 * - `off`: no injection at all, the Agent calls models as authored.
 */
export const PROJECT_MODEL_GATEWAY_MODES = ["platform", "project-key", "off"] as const;

export type ProjectModelGatewayMode = (typeof PROJECT_MODEL_GATEWAY_MODES)[number];

export function isProjectModelGatewayMode(value: unknown): value is ProjectModelGatewayMode {
  return (
    typeof value === "string" && (PROJECT_MODEL_GATEWAY_MODES as readonly string[]).includes(value)
  );
}

export const DEFAULT_PROJECT_MODEL_GATEWAY_MODE: ProjectModelGatewayMode = "platform";

/** The alias an issued key carries on the gateway, unique per project. */
export function modelGatewayKeyAlias(projectId: string): string {
  return `eveland-${projectId}`;
}

/** The instance's Model Gateway as the Dashboard sees it: the credential never leaves the server. */
export type ModelGateway = {
  kind: ModelGatewayKind;
  baseUrl: string | null;
  credentialConfigured: true;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ModelGatewayRecord = Omit<ModelGateway, "credentialConfigured"> & {
  /** For a key-issuing kind, the management credential; otherwise the shared key. */
  encryptedCredential: string;
};

/**
 * Identifies the gateway a key was issued on. A key issued on one gateway is
 * meaningless on another, so a changed identity means issuing again.
 */
export function modelGatewayIdentity(gateway: Pick<ModelGateway, "kind" | "baseUrl">): string {
  return `${gateway.kind}:${gateway.baseUrl ?? ""}`;
}

/** A key Eveland issued for one project on a key-issuing gateway. */
export type IssuedModelGatewayKeyRecord = {
  alias: string;
  encryptedKey: string;
  gatewayIdentity: string;
  /**
   * `pending` until the gateway confirmed it: the value is stored before it is
   * registered, because a gateway keeps only a hash and a key lost between the
   * two steps could never be recovered.
   */
  state: "pending" | "registered";
  issuedAt: string;
};

export type ProjectModelGatewayRecord = {
  projectId: string;
  mode: ProjectModelGatewayMode;
  encryptedProjectKey: string | null;
  issuedKey: IssuedModelGatewayKeyRecord | null;
  /** A replacement key stored before a rotation registers it on the gateway. */
  encryptedPendingRotationKey: string | null;
  updatedAt: string | null;
};

export type ProjectModelGateway = {
  projectId: string;
  mode: ProjectModelGatewayMode;
  projectKeyConfigured: boolean;
  issuedKey: {
    alias: string;
    state: IssuedModelGatewayKeyRecord["state"];
    issuedAt: string;
  } | null;
  updatedAt: string | null;
};

export function projectModelGatewayToPublic(
  record: ProjectModelGatewayRecord,
): ProjectModelGateway {
  return {
    projectId: record.projectId,
    mode: record.mode,
    projectKeyConfigured: record.encryptedProjectKey !== null,
    issuedKey:
      record.issuedKey === null
        ? null
        : {
            alias: record.issuedKey.alias,
            state: record.issuedKey.state,
            issuedAt: record.issuedKey.issuedAt,
          },
    updatedAt: record.updatedAt,
  };
}
