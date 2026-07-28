import {
  TELEMETRY_DOMAINS,
  type ExternalDestinationConfigPatch,
  type ObservabilitySignal,
  type PublicExternalObservabilityDestination,
  type TelemetryDomain,
} from "@eveland/core/observability";

export type ObservabilityDestination =
  PublicExternalObservabilityDestination;
export type DestinationKind = ExternalDestinationConfigPatch["kind"];
export type DestinationDraft = {
  kind: DestinationKind;
  endpoint: string;
  authorizationType: "bearer" | "api_key";
  credential: string;
  publicKey: string;
  secretKey: string;
  signals: Record<ObservabilitySignal, boolean>;
  domains: Record<TelemetryDomain, boolean>;
  headers: string;
};

export type DestinationEditor = {
  destinationId: string | null;
  draft: DestinationDraft;
  storedCredentials: { headerNames: string[] } | null;
};

export const destinationKindItems = [
  { value: "elastic", label: "Elastic" },
  { value: "langfuse", label: "Langfuse" },
  { value: "custom_otlp", label: "Custom OTLP" },
] as const;

export function emptyDestinationDraft(): DestinationDraft {
  return {
    kind: "elastic",
    endpoint: "",
    authorizationType: "bearer",
    credential: "",
    publicKey: "",
    secretKey: "",
    signals: { traces: true, logs: true, metrics: true },
    domains: { agent: true, platform: true, runtime: true, capacity: true },
    headers: "{}",
  };
}

export function destinationKindLabel(kind: DestinationKind): string {
  return (
    destinationKindItems.find((item) => item.value === kind)?.label ??
    "Custom OTLP"
  );
}

export function draftFromDestination(
  destination: ObservabilityDestination,
): DestinationDraft {
  const config = destination.config;
  const signals: readonly ObservabilitySignal[] =
    destination.supportedSignals;
  const domains: readonly TelemetryDomain[] =
    "domains" in destination ? destination.domains : TELEMETRY_DOMAINS;
  return {
    kind: destination.kind,
    endpoint: config
      ? config.kind === "langfuse"
        ? config.baseUrl
        : config.endpoint
      : "",
    authorizationType:
      config?.kind === "elastic" ? config.authorization.type : "bearer",
    credential: "",
    publicKey: "",
    secretKey: "",
    signals: {
      traces: signals.includes("traces"),
      logs: signals.includes("logs"),
      metrics: signals.includes("metrics"),
    },
    domains: {
      agent: domains.includes("agent"),
      platform: domains.includes("platform"),
      runtime: domains.includes("runtime"),
      capacity: domains.includes("capacity"),
    },
    headers: "",
  };
}

export function destinationPatch(
  draft: DestinationDraft,
): ExternalDestinationConfigPatch {
  if (draft.kind === "elastic") {
    return {
      kind: "elastic",
      endpoint: draft.endpoint,
      authorization: {
        type: draft.authorizationType,
        ...(draft.credential ? { value: draft.credential } : {}),
      },
    };
  }
  if (draft.kind === "langfuse") {
    return {
      kind: "langfuse",
      baseUrl: draft.endpoint,
      ...(draft.publicKey ? { publicKey: draft.publicKey } : {}),
      ...(draft.secretKey ? { secretKey: draft.secretKey } : {}),
    };
  }

  const supportedSignals = (
    Object.entries(draft.signals) as [ObservabilitySignal, boolean][]
  )
    .filter(([, enabled]) => enabled)
    .map(([signal]) => signal);
  const domains = (
    Object.entries(draft.domains) as [TelemetryDomain, boolean][]
  )
    .filter(([, enabled]) => enabled)
    .map(([domain]) => domain);
  if (supportedSignals.length === 0 || domains.length === 0) {
    throw new Error("Select at least one signal and one telemetry domain.");
  }
  return {
    kind: "custom_otlp",
    endpoint: draft.endpoint,
    supportedSignals,
    domains,
    ...(draft.headers.trim() ? { headers: parseHeaders(draft.headers) } : {}),
  };
}

function parseHeaders(input: string): Record<string, string> {
  const headers: unknown = JSON.parse(input);
  if (
    !headers ||
    typeof headers !== "object" ||
    Array.isArray(headers) ||
    Object.values(headers).some((value) => typeof value !== "string")
  ) {
    throw new Error("Headers must be a JSON object with string values.");
  }
  return headers as Record<string, string>;
}
