import {
  agentCapturePolicySchema,
  externalDestinationConfigPatchSchema,
  type ExternalDestinationConfig,
} from "@evelandhq/core/observability";
import { DEFAULT_TEAM_ID, type Store } from "@evelandhq/db";
import { z } from "zod";
import type { ApiApp, AppOptions } from "./app-types.js";
import { createObservabilityPolicyService } from "./observability/policy-service.js";

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

export function registerObservabilityRoutes(input: {
  app: ApiApp;
  store: Store;
  options: AppOptions;
  appSecretKey: string;
}): void {
  const { app, store, options, appSecretKey } = input;
  const policyService = createObservabilityPolicyService({
    store,
    options,
    appSecretKey,
  });

  app.get("/api/system/observability", async (c) => {
    return c.json(await policyService.getPublicPolicy());
  });

  app.put("/api/system/observability", async (c) => {
    const parsed = updateAgentCaptureSchema.safeParse(await c.req.json().catch(() => null));
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
      ? c.json(await policyService.getPublicPolicy(updated))
      : c.json(
          {
            error: "Observability policy changed; reload and try again.",
          },
          409,
        );
  });

  app.post("/api/system/observability/destinations", async (c) => {
    const parsed = createDestinationSchema.safeParse(await c.req.json().catch(() => null));
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
      config = await policyService.resolveDestinationConfig(parsed.data.config);
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
    const destination = policyService.createDestination(config);
    const updated = await store.saveObservabilityPolicy({
      teamId: DEFAULT_TEAM_ID,
      expectedRevision: parsed.data.expectedRevision,
      agentCapture: current.agentCapture,
      externalDestinations: [...current.externalDestinations, destination],
    });
    if (!updated) {
      return c.json(
        {
          error: "Observability policy changed; reload and try again.",
        },
        409,
      );
    }
    await policyService.markDestinationProbePending(destination.id, destination.enabled);
    return c.json(await policyService.getPublicPolicy(updated), 201);
  });

  app.put("/api/system/observability/destinations/:destinationId", async (c) => {
    const parsed = updateDestinationSchema.safeParse(await c.req.json().catch(() => null));
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
      config = await policyService.resolveDestinationConfig(parsed.data.config, existing);
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
    const replacement = policyService.createDestination(config, {
      id: existing.id,
      enabled: parsed.data.enabled ?? existing.enabled,
      securityRevision: existing.securityRevision + 1,
    });
    const updated = await policyService.saveDestinations(
      current,
      parsed.data.expectedRevision,
      current.externalDestinations.map((destination) =>
        destination.id === existing.id ? replacement : destination,
      ),
    );
    if (!updated) {
      return c.json(
        {
          error: "Observability policy changed; reload and try again.",
        },
        409,
      );
    }
    await policyService.markDestinationProbePending(replacement.id, replacement.enabled);
    return c.json(await policyService.getPublicPolicy(updated));
  });

  app.patch("/api/system/observability/destinations/:destinationId", async (c) => {
    const parsed = toggleDestinationSchema.safeParse(await c.req.json().catch(() => null));
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
    const updated = await policyService.saveDestinations(
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
          error: "Observability policy changed; reload and try again.",
        },
        409,
      );
    }
    await policyService.markDestinationProbePending(existing.id, parsed.data.enabled);
    return c.json(await policyService.getPublicPolicy(updated));
  });

  app.delete("/api/system/observability/destinations/:destinationId", async (c) => {
    const parsed = deleteDestinationSchema.safeParse(await c.req.json().catch(() => null));
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
    const updated = await policyService.saveDestinations(
      current,
      parsed.data.expectedRevision,
      current.externalDestinations.filter(
        (destination) => destination.id !== c.req.param("destinationId"),
      ),
    );
    return updated
      ? c.json(await policyService.getPublicPolicy(updated))
      : c.json({ error: "Observability policy changed; reload and try again." }, 409);
  });
}
