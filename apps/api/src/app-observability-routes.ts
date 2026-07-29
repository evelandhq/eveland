import {
  agentCapturePolicySchema,
  toPublicObservabilityPolicy,
} from "@eveland/core/observability";
import { DEFAULT_TEAM_ID, type Store } from "@eveland/db";
import { z } from "zod";
import type { ApiApp, AppOptions } from "./app-types.js";

const updateAgentCaptureSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    agentCapture: agentCapturePolicySchema,
  })
  .strict();

export function registerObservabilityRoutes(input: {
  app: ApiApp;
  store: Store;
  options: AppOptions;
}): void {
  const { app, store, options } = input;

  app.get("/system/observability", async (c) => {
    if (options.auth && c.get("principal").role !== "admin") {
      return c.json({ error: "Admin access required" }, 403);
    }
    return c.json(
      toPublicObservabilityPolicy(
        await store.getObservabilityPolicy(DEFAULT_TEAM_ID),
      ),
    );
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
      ? c.json(toPublicObservabilityPolicy(updated))
      : c.json(
          {
            error:
              "Observability policy changed; reload and try again.",
          },
          409,
        );
  });
}
