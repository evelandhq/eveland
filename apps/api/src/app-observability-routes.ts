import {
  COLLECTOR_SELF_SERVICE_NAME,
  TELEMETRY_DOMAINS,
  agentCapturePolicySchema,
  collectorExporterComponentId,
  externalDestinationConfigSchema,
  summarizeCollectorDelivery,
  toPublicObservabilityPolicy,
  type ExternalDestinationConfig,
  type ExternalObservabilityDestination,
  type ObservabilityPolicy,
} from "@eveland/core/observability";
import { createId } from "@eveland/core/ids";
import { encryptSecretValue } from "@eveland/core/server/secrets";
import { DEFAULT_TEAM_ID, type Store } from "@eveland/db";
import { z } from "zod";
import type { ApiApp, AppOptions } from "./app-types.js";

const updateAgentCaptureSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    agentCapture: agentCapturePolicySchema,
  })
  .strict();
const createDestinationSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    config: externalDestinationConfigSchema,
  })
  .strict();
const updateDestinationSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    config: externalDestinationConfigSchema,
    enabled: z.boolean().optional(),
  })
  .strict();
const toggleDestinationSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    enabled: z.boolean(),
  })
  .strict();
const deleteDestinationSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const activityQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    hours: z.coerce.number().int().min(1).max(168).default(24),
    domain: z.enum(TELEMETRY_DOMAINS).optional(),
    serviceName: z.string().trim().min(1).max(200).optional(),
    projectId: z.string().trim().min(1).max(200).optional(),
    name: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export function registerObservabilityRoutes(input: {
  app: ApiApp;
  store: Store;
  options: AppOptions;
  appSecretKey: string;
}): void {
  const { app, store, options, appSecretKey } = input;

  app.get("/system/observability", async (c) => {
    if (options.auth && c.get("principal").role !== "admin") {
      return c.json({ error: "Admin access required" }, 403);
    }
    return c.json(await publicPolicy(store));
  });

  app.get("/system/observability/activity", async (c) => {
    if (options.auth && c.get("principal").role !== "admin") {
      return c.json({ error: "Admin access required" }, 403);
    }
    const parsed = activityQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid observability activity query",
          issues: parsed.error.issues,
        },
        400,
      );
    }
    const { hours, ...query } = parsed.data;
    const windowEnd = new Date();
    const windowStart = new Date(
      windowEnd.getTime() - hours * 60 * 60 * 1_000,
    );
    const [
      spans,
      logs,
      metrics,
      collectorMetrics,
      policy,
      operations,
    ] =
      await Promise.all([
        store.listOtlpSpans(query),
        store.listOtlpLogRecords(query),
        store.listOtlpMetricPoints(query),
        store.listOtlpMetricPoints({
          serviceName: COLLECTOR_SELF_SERVICE_NAME,
          limit: 2_000,
        }),
        store.getObservabilityPolicy(DEFAULT_TEAM_ID),
        store.summarizeOtlpSpanOperations({
          since: windowStart,
          until: windowEnd,
        }),
      ]);
    const delivery = summarizeCollectorDelivery(
      collectorMetrics,
      [
        {
          id: "builtin",
          label: "Built-in",
          exporterId: "otlp_http/builtin",
          supportedSignals: ["traces", "logs", "metrics"],
        },
        ...policy.externalDestinations
          .filter((destination) => destination.enabled)
          .map((destination) => ({
            id: destination.id,
            label: destinationLabel(destination.kind),
            exporterId: collectorExporterComponentId(destination.id),
            supportedSignals: destination.supportedSignals,
        })),
      ],
    );
    return c.json({
      spans,
      logs,
      metrics,
      delivery,
      platform: {
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        operations,
      },
    });
  });

  app.put("/system/observability", async (c) => {
    if (options.auth && c.get("principal").role !== "admin") {
      return c.json({ error: "Admin access required" }, 403);
    }
    const parsed = updateAgentCaptureSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid observability policy",
          issues: parsed.error.issues,
        },
        400,
      );
    }
    const current = await store.getObservabilityPolicy(DEFAULT_TEAM_ID);
    const updated = await store.saveObservabilityPolicy({
      teamId: DEFAULT_TEAM_ID,
      expectedRevision: parsed.data.expectedRevision,
      agentCapture: parsed.data.agentCapture,
      externalDestinations: current.externalDestinations,
    });
    return updated
      ? c.json(await publicPolicy(store, updated))
      : c.json(
          {
            error:
              "Observability policy changed; reload and try again.",
          },
          409,
      );
  });

  app.post("/system/observability/destinations", async (c) => {
    if (options.auth && c.get("principal").role !== "admin") {
      return c.json({ error: "Admin access required" }, 403);
    }
    const parsed = createDestinationSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid observability destination", issues: parsed.error.issues },
        400,
      );
    }
    const current = await store.getObservabilityPolicy(DEFAULT_TEAM_ID);
    if (
      parsed.data.config.kind !== "custom_otlp" &&
      current.externalDestinations.some(
        (destination) => destination.kind === parsed.data.config.kind,
      )
    ) {
      return c.json(
        { error: `A ${parsed.data.config.kind} destination is already configured.` },
        409,
      );
    }
    const destination = createDestination(
      parsed.data.config,
      appSecretKey,
    );
    const updated = await store.saveObservabilityPolicy({
      teamId: DEFAULT_TEAM_ID,
      expectedRevision: parsed.data.expectedRevision,
      agentCapture: current.agentCapture,
      externalDestinations: [
        ...current.externalDestinations,
        destination,
      ],
    });
    if (!updated) {
      return c.json(
        {
          error:
            "Observability policy changed; reload and try again.",
        },
        409,
      );
    }
    await markDestinationProbePending(
      store,
      destination.id,
      destination.enabled,
    );
    return c.json(await publicPolicy(store, updated), 201);
  });

  app.put("/system/observability/destinations/:destinationId", async (c) => {
    if (options.auth && c.get("principal").role !== "admin") {
      return c.json({ error: "Admin access required" }, 403);
    }
    const parsed = updateDestinationSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid observability destination", issues: parsed.error.issues },
        400,
      );
    }
    const current = await store.getObservabilityPolicy(DEFAULT_TEAM_ID);
    const existing = current.externalDestinations.find(
      (destination) => destination.id === c.req.param("destinationId"),
    );
    if (!existing) return c.json({ error: "Destination not found" }, 404);
    if (existing.kind !== parsed.data.config.kind) {
      return c.json({ error: "Destination kind cannot be changed" }, 400);
    }
    const replacement = createDestination(parsed.data.config, appSecretKey, {
      id: existing.id,
      enabled: parsed.data.enabled ?? existing.enabled,
      securityRevision: existing.securityRevision + 1,
    });
    const updated = await saveDestinations(
      store,
      current,
      parsed.data.expectedRevision,
      current.externalDestinations.map((destination) =>
        destination.id === existing.id ? replacement : destination,
      ),
    );
    if (!updated) {
      return c.json(
        {
          error:
            "Observability policy changed; reload and try again.",
        },
        409,
      );
    }
    await markDestinationProbePending(
      store,
      replacement.id,
      replacement.enabled,
    );
    return c.json(await publicPolicy(store, updated));
  });

  app.patch("/system/observability/destinations/:destinationId", async (c) => {
    if (options.auth && c.get("principal").role !== "admin") {
      return c.json({ error: "Admin access required" }, 403);
    }
    const parsed = toggleDestinationSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid observability destination", issues: parsed.error.issues },
        400,
      );
    }
    const current = await store.getObservabilityPolicy(DEFAULT_TEAM_ID);
    const existing = current.externalDestinations.find(
      (destination) => destination.id === c.req.param("destinationId"),
    );
    if (!existing) return c.json({ error: "Destination not found" }, 404);
    const updated = await saveDestinations(
      store,
      current,
      parsed.data.expectedRevision,
      current.externalDestinations.map((destination) =>
        destination.id === existing.id
          ? { ...destination, enabled: parsed.data.enabled }
          : destination,
      ),
    );
    if (!updated) {
      return c.json(
        {
          error:
            "Observability policy changed; reload and try again.",
        },
        409,
      );
    }
    await markDestinationProbePending(
      store,
      existing.id,
      parsed.data.enabled,
    );
    return c.json(await publicPolicy(store, updated));
  });

  app.delete("/system/observability/destinations/:destinationId", async (c) => {
    if (options.auth && c.get("principal").role !== "admin") {
      return c.json({ error: "Admin access required" }, 403);
    }
    const parsed = deleteDestinationSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid observability destination", issues: parsed.error.issues },
        400,
      );
    }
    const current = await store.getObservabilityPolicy(DEFAULT_TEAM_ID);
    if (
      !current.externalDestinations.some(
        (destination) => destination.id === c.req.param("destinationId"),
      )
    ) {
      return c.json({ error: "Destination not found" }, 404);
    }
    const updated = await saveDestinations(
      store,
      current,
      parsed.data.expectedRevision,
      current.externalDestinations.filter(
        (destination) => destination.id !== c.req.param("destinationId"),
      ),
    );
    return updated
      ? c.json(await publicPolicy(store, updated))
      : c.json({ error: "Observability policy changed; reload and try again." }, 409);
  });
}

function destinationLabel(
  kind: ExternalObservabilityDestination["kind"],
): string {
  return kind === "elastic"
    ? "Elastic"
    : kind === "langfuse"
      ? "Langfuse"
      : "Custom OTLP";
}

function createDestination(
  config: ExternalDestinationConfig,
  appSecretKey: string,
  existing: {
    id: string;
    enabled: boolean;
    securityRevision: number;
  } = {
    id: createId("destination"),
    enabled: true,
    securityRevision: 1,
  },
): ExternalObservabilityDestination {
  const common = {
    ...existing,
    encryptedConfig: JSON.stringify(
      encryptSecretValue(JSON.stringify(config), appSecretKey),
    ),
  };
  switch (config.kind) {
    case "elastic":
      return {
        ...common,
        kind: "elastic",
        supportedSignals: ["traces", "logs", "metrics"],
        filterProfile: "all_eveland",
      };
    case "langfuse":
      return {
        ...common,
        kind: "langfuse",
        supportedSignals: ["traces"],
        filterProfile: "agent_genai",
      };
    case "custom_otlp":
      return {
        ...common,
        kind: "custom_otlp",
        supportedSignals: config.supportedSignals,
        domains: config.domains,
        filterProfile: "custom",
      };
  }
}

async function saveDestinations(
  store: Store,
  current: ObservabilityPolicy,
  expectedRevision: number,
  externalDestinations: ExternalObservabilityDestination[],
) {
  return store.saveObservabilityPolicy({
    teamId: DEFAULT_TEAM_ID,
    expectedRevision,
    agentCapture: current.agentCapture,
    externalDestinations,
  });
}

async function markDestinationProbePending(
  store: Store,
  destinationId: string,
  enabled: boolean,
): Promise<void> {
  await store.upsertExternalObservabilityDestinationHealth({
    destinationId,
    status: enabled ? "pending" : "paused",
    checkedAt: null,
    lastSuccessAt: null,
    lastError: null,
  });
}

async function publicPolicy(
  store: Store,
  policy?: ObservabilityPolicy,
) {
  const resolvedPolicy =
    policy ?? (await store.getObservabilityPolicy(DEFAULT_TEAM_ID));
  const [batches, destinationHealth] = await Promise.all([
    store.listOtlpBatches({ limit: 1 }),
    store.listExternalObservabilityDestinationHealth(),
  ]);
  const [latestBatch] = batches;
  return toPublicObservabilityPolicy(
    resolvedPolicy,
    {
      status: latestBatch ? "healthy" : "waiting",
      lastReceivedAt: latestBatch?.receivedAt ?? null,
    },
    destinationHealth,
  );
}
