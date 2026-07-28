import {
  agentCapturePolicySchema,
  externalDestinationConfigPatchSchema,
  mergeExternalDestinationConfig,
  toPublicExternalDestinationConfig,
  toPublicObservabilityPolicy,
  type ExternalDestinationConfig,
  type ExternalObservabilityDestination,
  type ObservabilityPolicy,
  type PublicExternalDestinationConfig,
} from "@eveland/core/observability";
import { createId } from "@eveland/core/ids";
import { deriveAgentTelemetrySecret } from "@eveland/core/server/agent-telemetry-credential";
import {
  decryptDestinationConfig,
  encryptDestinationConfig,
  parseObservabilityPrivateHostAllowlist,
  requestExternalObservabilityDestination,
  validateExternalObservabilityDestination,
} from "@eveland/core/server/observability";
import { DEFAULT_TEAM_ID, type Store } from "@eveland/db";
import { runWithPlatformTracingSuppressed } from "@eveland/platform-observability";
import { z } from "zod";
import type { ApiApp, AppOptions } from "./app-types.js";
import { isServiceRequest } from "./app-support.js";
import { prepareExternalOtlpJson } from "./observability-egress.js";

const maxExternalOtlpRequestBytes = 16 * 1024 * 1024;
const externalOtlpContentType = "application/json";

const updateAgentCaptureSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    agentCapture: agentCapturePolicySchema,
  })
  .strict();
const createDestinationSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    config: externalDestinationConfigPatchSchema,
  })
  .strict();
const updateDestinationSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    config: externalDestinationConfigPatchSchema,
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

/**
 * Registered alongside the other internal routes, ahead of the session-auth
 * middleware: the Collector authenticates with the OTLP service token and
 * carries no session, so a route behind that middleware would 401 before its
 * own token check ever runs.
 */
export function registerObservabilityProxyRoute(input: {
  app: ApiApp;
  store: Store;
  options: AppOptions;
  appSecretKey: string;
}): void {
  const { app, store, options, appSecretKey } = input;
  const telemetrySecret = deriveAgentTelemetrySecret(appSecretKey);

  app.post(
    "/internal/observability/destinations/:destinationId/v1/:signal",
    async (c) => {
      const token =
        options.otlpServiceToken ?? process.env.EVELAND_OTLP_SERVICE_TOKEN;
      if (!isServiceRequest(c.req.header("authorization"), token)) {
        return c.json({ error: "Not found" }, 404);
      }
      const signal = parseSignal(c.req.param("signal"));
      if (!signal) return c.json({ error: "Not found" }, 404);
      const contentType = c.req
        .header("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== externalOtlpContentType) {
        return c.json({ error: "OTLP/HTTP JSON is required" }, 415);
      }
      const contentLength = Number(c.req.header("content-length") ?? 0);
      if (
        Number.isFinite(contentLength) &&
        contentLength > maxExternalOtlpRequestBytes
      ) {
        return c.json({ error: "OTLP request is too large" }, 413);
      }
      const receivedBody = new Uint8Array(await c.req.arrayBuffer());
      if (receivedBody.byteLength > maxExternalOtlpRequestBytes) {
        return c.json({ error: "OTLP request is too large" }, 413);
      }
      const body = await prepareExternalOtlpJson({
        body: receivedBody,
        signal,
        store,
        telemetrySecret,
        environment:
          process.env.NODE_ENV === "production"
            ? "production"
            : "development",
      });
      if (!body) {
        return c.json({ error: "Invalid OTLP request" }, 400);
      }
      const policy = await store.getObservabilityPolicy(DEFAULT_TEAM_ID);
      const destination = policy.externalDestinations.find(
        (candidate) =>
          candidate.id === c.req.param("destinationId") &&
          candidate.enabled &&
          (candidate.supportedSignals as readonly string[]).includes(signal),
      );
      if (!destination) return c.json({ error: "Not found" }, 404);
      let config: ExternalDestinationConfig;
      try {
        config = decryptDestinationConfig(
          destination.encryptedConfig,
          appSecretKey,
        );
        if (config.kind !== destination.kind) {
          throw new Error("Destination kind does not match.");
        }
        const response = await runWithPlatformTracingSuppressed(() =>
          (
            options.forwardExternalObservabilityRequest ??
            requestExternalObservabilityDestination
          )({
            config,
            signal,
            contentType,
            body,
            privateHostAllowlist:
              parseObservabilityPrivateHostAllowlist(
                process.env
                  .EVELAND_OBSERVABILITY_PRIVATE_ENDPOINT_ALLOWLIST,
              ),
          }),
        );
        return new Response(Uint8Array.from(response.body).buffer, {
          status: response.status,
          headers: response.contentType
            ? { "content-type": response.contentType }
            : undefined,
        });
      } catch {
        return c.json(
          { error: "External observability destination is unavailable" },
          502,
        );
      }
    },
  );
}

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
    return c.json(await publicPolicy(store, appSecretKey));
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
      ? c.json(await publicPolicy(store, appSecretKey, updated))
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
    let config: ExternalDestinationConfig;
    try {
      config = mergeExternalDestinationConfig(parsed.data.config, null);
      await validateDestination(options, config);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Invalid observability destination configuration.",
        },
        422,
      );
    }
    const destination = createDestination(config, appSecretKey);
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
    return c.json(await publicPolicy(store, appSecretKey, updated), 201);
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
    let config: ExternalDestinationConfig;
    try {
      config = mergeExternalDestinationConfig(
        parsed.data.config,
        readDestinationConfig(existing, appSecretKey),
      );
      await validateDestination(options, config);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Invalid observability destination configuration.",
        },
        422,
      );
    }
    const replacement = createDestination(config, appSecretKey, {
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
    return c.json(await publicPolicy(store, appSecretKey, updated));
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
    return c.json(await publicPolicy(store, appSecretKey, updated));
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
      ? c.json(await publicPolicy(store, appSecretKey, updated))
      : c.json({ error: "Observability policy changed; reload and try again." }, 409);
  });
}

function parseSignal(value: string) {
  return value === "traces" || value === "logs" || value === "metrics"
    ? value
    : null;
}

async function validateDestination(
  options: AppOptions,
  config: ExternalDestinationConfig,
): Promise<void> {
  if (options.validateObservabilityDestination) {
    await options.validateObservabilityDestination(config);
    return;
  }
  await validateExternalObservabilityDestination(config, {
    privateHostAllowlist: parseObservabilityPrivateHostAllowlist(
      process.env.EVELAND_OBSERVABILITY_PRIVATE_ENDPOINT_ALLOWLIST,
    ),
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
    encryptedConfig: encryptDestinationConfig(config, appSecretKey),
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

/**
 * Null when the sealed configuration cannot be opened — a rotated `APP_SECRET_KEY` leaves
 * a destination that is still configured but no longer readable, and the Admin has to see
 * it in order to replace it.
 */
function readDestinationConfig(
  destination: ExternalObservabilityDestination,
  appSecretKey: string,
): ExternalDestinationConfig | null {
  try {
    return decryptDestinationConfig(destination.encryptedConfig, appSecretKey);
  } catch {
    return null;
  }
}

async function publicPolicy(
  store: Store,
  appSecretKey: string,
  policy?: ObservabilityPolicy,
) {
  const resolvedPolicy =
    policy ?? (await store.getObservabilityPolicy(DEFAULT_TEAM_ID));
  const destinationHealth =
    await store.listExternalObservabilityDestinationHealth();
  const destinationConfigs = new Map<string, PublicExternalDestinationConfig>();
  for (const destination of resolvedPolicy.externalDestinations) {
    const config = readDestinationConfig(destination, appSecretKey);
    if (config) {
      destinationConfigs.set(
        destination.id,
        toPublicExternalDestinationConfig(config),
      );
    }
  }
  return toPublicObservabilityPolicy(resolvedPolicy, {
    destinationHealth,
    destinationConfigs,
  });
}
