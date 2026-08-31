import type { InstanceHealthStore, ObservabilityStore } from "@evelandhq/db";
import { GATEWAY_INTERNAL_URL_FALLBACK } from "@evelandhq/core/ports";
import {
  analyzeHostCapacity,
  summarizeWorkerHealth,
  type InstanceComponentHealth,
  type InstanceHealthReport,
} from "@evelandhq/core/instance-health";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ComponentObservation = Omit<InstanceComponentHealth, "key" | "label">;

export type InstanceHealthReadStore = Pick<
  InstanceHealthStore,
  "listWorkerHeartbeats" | "listHostMetrics" | "getInstanceWorkload"
> &
  Pick<ObservabilityStore, "latestOtlpBatchReceivedAt">;

export async function collectInstanceHealth(
  store: InstanceHealthReadStore,
  options: {
    now?: () => Date;
    historyHours: number;
    gatewayHealth: () => Promise<ComponentObservation>;
  },
): Promise<InstanceHealthReport> {
  const now = options.now?.() ?? new Date();
  const since = new Date(now.getTime() - options.historyHours * 3_600_000);
  const [heartbeats, metrics, workload, gateway, lastBatchAt] = await Promise.all([
    store.listWorkerHeartbeats(),
    store.listHostMetrics({
      since,
      limit: Math.min(10_100, options.historyHours * 60 + 100),
    }),
    store.getInstanceWorkload(),
    options.gatewayHealth(),
    store.latestOtlpBatchReceivedAt(),
  ]);
  const worker = summarizeWorkerHealth(heartbeats[0] ?? null, now);
  // The Collector is the only sender to Built-in, so a recent batch is what proves it
  // is alive. Eveland keeps no monitoring of the Collector beyond this liveness fact;
  // its own metrics go to whichever external destination the Admin configures.
  const collectorObservation: ComponentObservation =
    lastBatchAt === null
      ? {
          status: "warning",
          message: "No telemetry batch has been received yet.",
          observedAt: null,
        }
      : now.getTime() - Date.parse(lastBatchAt) > 90_000
        ? {
            status: "unavailable",
            message: "No telemetry batch received recently.",
            observedAt: lastBatchAt,
          }
        : {
            status: "healthy",
            message: "Telemetry batches are arriving.",
            observedAt: lastBatchAt,
          };
  const components: InstanceComponentHealth[] = [
    {
      key: "api",
      label: "API",
      status: "healthy",
      message: "The Eveland API is serving this report.",
      observedAt: now.toISOString(),
    },
    {
      key: "postgres",
      label: "Postgres",
      status: "healthy",
      message: "Health and workload queries succeeded.",
      observedAt: now.toISOString(),
    },
    { key: "gateway", label: "Agent Gateway", ...gateway },
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
    workload: {
      ...workload,
      // The cap lives with the worker's machine, not the jobs table; the
      // freshest heartbeat is the only place it is published.
      maxConcurrentHeavyJobs: heartbeats[0]?.maxConcurrentHeavyJobs ?? null,
    },
  };
}

export async function probeGatewayHealth(
  env: Record<string, string | undefined>,
  fetcher: Fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<ComponentObservation> {
  const gatewayUrl = (env.EVELAND_GATEWAY_INTERNAL_URL ?? GATEWAY_INTERNAL_URL_FALLBACK).replace(
    /\/$/,
    "",
  );
  try {
    const response = await fetcher(`${gatewayUrl}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("Agent Gateway returned an unhealthy response.");
    const body = (await response.json().catch(() => null)) as {
      ok?: unknown;
      component?: unknown;
    } | null;
    if (body?.ok !== true || body.component !== "gateway")
      throw new Error("Agent Gateway returned invalid health data.");
    return {
      status: "healthy",
      message: "Agent Gateway health endpoint is reachable.",
      observedAt: now().toISOString(),
    };
  } catch {
    return {
      status: "unavailable",
      message: "Agent Gateway health endpoint is unavailable.",
      observedAt: null,
    };
  }
}

function overallStatus(
  components: InstanceComponentHealth[],
  capacity: "healthy" | "warning" | "critical",
): InstanceHealthReport["status"] {
  if (components.some((component) => component.status === "unavailable")) return "unavailable";
  if (capacity === "critical" || components.some((component) => component.status === "critical"))
    return "critical";
  if (capacity === "warning" || components.some((component) => component.status === "warning"))
    return "warning";
  return "healthy";
}
