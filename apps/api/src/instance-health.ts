import type { Store } from "@eveland/db";
import {
  analyzeHostCapacity,
  summarizeWorkerHealth,
  type InstanceComponentHealth,
  type InstanceHealthReport,
} from "@eveland/core/instance-health";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ComponentObservation = Omit<InstanceComponentHealth, "key" | "label">;

export async function collectInstanceHealth(
  store: Store,
  options: {
    now?: () => Date;
    historyHours: number;
    gatewayHealth: () => Promise<ComponentObservation>;
  },
): Promise<InstanceHealthReport> {
  const now = options.now?.() ?? new Date();
  const since = new Date(now.getTime() - options.historyHours * 3_600_000);
  const [heartbeats, metrics, workload, gateway, otlpBatches] = await Promise.all([
    store.listWorkerHeartbeats(),
    store.listHostMetrics({ since, limit: Math.min(10_100, options.historyHours * 60 + 100) }),
    store.getInstanceWorkload(),
    options.gatewayHealth(),
    store.listOtlpBatches({ limit: 1 }),
  ]);
  const worker = summarizeWorkerHealth(heartbeats[0] ?? null, now);
  const latestBatch = otlpBatches[0];
  const collectorObservation: ComponentObservation = latestBatch
    ? {
        status: "healthy",
        message: "Built-in OTLP ingestion has received telemetry.",
        observedAt: latestBatch.receivedAt,
      }
    : {
        status: "warning",
        message: "Built-in OTLP ingestion has not received telemetry.",
        observedAt: null,
      };
  const components: InstanceComponentHealth[] = [
    { key: "api", label: "API", status: "healthy", message: "Control-plane API is serving this report.", observedAt: now.toISOString() },
    { key: "postgres", label: "Postgres", status: "healthy", message: "Health and workload queries succeeded.", observedAt: now.toISOString() },
    { key: "gateway", label: "Gateway", ...gateway },
    { key: "worker", label: "Worker", ...worker },
    { key: "collector", label: "OpenTelemetry", ...collectorObservation },
  ];
  const capacity = analyzeHostCapacity(metrics);
  return {
    status: overallStatus(components, capacity.overall),
    generatedAt: now.toISOString(),
    historyHours: options.historyHours,
    components,
    capacity,
    metrics,
    workload,
  };
}

export async function probeGatewayHealth(
  env: Record<string, string | undefined>,
  fetcher: Fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<ComponentObservation> {
  const gatewayUrl = (env.EVELAND_GATEWAY_INTERNAL_URL ?? "http://127.0.0.1:4080").replace(/\/$/, "");
  try {
    const response = await fetcher(`${gatewayUrl}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("Gateway returned an unhealthy response.");
    const body = await response.json().catch(() => null) as { ok?: unknown; component?: unknown } | null;
    if (body?.ok !== true || body.component !== "gateway") throw new Error("Gateway returned invalid health data.");
    return {
      status: "healthy",
      message: "Gateway health endpoint is reachable.",
      observedAt: now().toISOString(),
    };
  } catch {
    return {
      status: "unavailable",
      message: "Gateway health endpoint is unavailable.",
      observedAt: null,
    };
  }
}

function overallStatus(
  components: InstanceComponentHealth[],
  capacity: "healthy" | "warning" | "critical",
): InstanceHealthReport["status"] {
  if (components.some((component) => component.status === "unavailable")) return "unavailable";
  if (capacity === "critical" || components.some((component) => component.status === "critical")) return "critical";
  if (capacity === "warning" || components.some((component) => component.status === "warning")) return "warning";
  return "healthy";
}
