export const OBSERVABILITY_SIGNALS = ["traces", "logs", "metrics"] as const;
export const TELEMETRY_DOMAINS = [
  "agent",
  "platform",
  "runtime",
  "capacity",
] as const;

export type ObservabilitySignal = (typeof OBSERVABILITY_SIGNALS)[number];
export type TelemetryDomain = (typeof TELEMETRY_DOMAINS)[number];
