import {
  hashModelGatewayToken,
  mintModelGatewayToken,
} from "@evelandhq/core/server/model-gateway-token";
import { encryptSecretValue } from "@evelandhq/core/server/secrets";
import type { Store } from "@evelandhq/db";
import { z } from "zod";
import type { ApiApp } from "./app-types.js";

/** Narrow persistence port of the Model Gateway control plane. */
type ModelGatewayRoutesStore = Pick<
  Store,
  | "upsertModelGatewayProviderConnection"
  | "listModelGatewayProviderConnections"
  | "deleteModelGatewayProviderConnection"
  | "upsertModelGatewayModelRoute"
  | "listModelGatewayModelRoutes"
  | "deleteModelGatewayModelRoute"
  | "listModelGatewayRegistryEvents"
  | "mintModelGatewayApiKey"
  | "listModelGatewayApiKeys"
  | "revokeModelGatewayApiKey"
>;

export type VerifyProviderKey = (input: { baseUrl: string; apiKey: string }) => Promise<boolean>;

type ModelGatewayRoutesContext = {
  app: ApiApp;
  store: ModelGatewayRoutesStore;
  /** Encrypts provider credentials; the dedicated Model Gateway secret key. */
  modelGatewaySecretKey: string;
  verifyProviderKey: VerifyProviderKey;
};

const providerBodySchema = z.object({
  name: z.string().min(1).max(120),
  baseUrl: z.string().url().max(2048),
  apiKey: z.string().min(1).max(4096),
});

const providerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

const routeBodySchema = z.object({
  modelId: z
    .string()
    .min(3)
    .max(256)
    .regex(/^[^/\s]+\/[^\s]+$/, "modelId must look like creator/model"),
  providerId: providerIdSchema,
  providerModelId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(200).optional(),
});

const deleteRouteSchema = z.object({ modelId: z.string().min(1).max(256) });
const apiKeyBodySchema = z.object({ name: z.string().min(1).max(120) });

/**
 * Default verify-on-save probe: an OpenAI-compatible provider answers
 * GET {baseUrl}/models with the credential. Fail-closed — a key that cannot
 * be verified is never stored.
 */
export function defaultVerifyProviderKey(fetchImpl: typeof fetch = fetch): VerifyProviderKey {
  return async ({ baseUrl, apiKey }) => {
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}

export function registerModelGatewayRoutes({
  app,
  store,
  modelGatewaySecretKey,
  verifyProviderKey,
}: ModelGatewayRoutesContext): void {
  // ---- Operator surface (admin-only via the structural /system/* gate) ----

  app.get("/system/model-gateway/providers", async (c) => {
    const providers = (await store.listModelGatewayProviderConnections()).map(publicProvider);
    return c.json({ providers });
  });

  app.put("/system/model-gateway/providers/:providerId", async (c) => {
    const providerId = providerIdSchema.safeParse(c.req.param("providerId"));
    if (!providerId.success) {
      return c.json({ error: "Invalid provider id." }, 400);
    }
    const body = providerBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: "name, baseUrl, and apiKey are required." }, 400);
    }
    if (!(await verifyProviderKey({ baseUrl: body.data.baseUrl, apiKey: body.data.apiKey }))) {
      return c.json(
        {
          error:
            "The provider rejected this credential (or the endpoint is unreachable); nothing was saved.",
        },
        400,
      );
    }
    const provider = await store.upsertModelGatewayProviderConnection({
      providerId: providerId.data,
      name: body.data.name,
      baseUrl: body.data.baseUrl,
      encryptedApiKey: JSON.stringify(encryptSecretValue(body.data.apiKey, modelGatewaySecretKey)),
    });
    return c.json({ provider: publicProvider(provider) });
  });

  app.delete("/system/model-gateway/providers/:providerId", async (c) => {
    const deleted = await store.deleteModelGatewayProviderConnection(c.req.param("providerId"));
    if (!deleted) return c.json({ error: "Unknown provider." }, 404);
    return c.json({ ok: true });
  });

  app.put("/system/model-gateway/models", async (c) => {
    const body = routeBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: "modelId, providerId, and providerModelId are required." }, 400);
    }
    try {
      const route = await store.upsertModelGatewayModelRoute(body.data);
      return c.json({ route });
    } catch (error) {
      if (error instanceof Error && /unknown provider/i.test(error.message)) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  app.delete("/system/model-gateway/models", async (c) => {
    const body = deleteRouteSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "modelId is required." }, 400);
    const deleted = await store.deleteModelGatewayModelRoute(body.data.modelId);
    if (!deleted) return c.json({ error: "Unknown model route." }, 404);
    return c.json({ ok: true });
  });

  app.get("/system/model-gateway/registry-events", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    return c.json({ events: await store.listModelGatewayRegistryEvents(limit) });
  });

  // ---- Member surface (session boundary applies when auth is configured) ----

  app.get("/model-gateway/models", async (c) => {
    return c.json({ models: await store.listModelGatewayModelRoutes() });
  });

  app.post("/model-gateway/api-keys", async (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Authentication required" }, 401);
    const body = apiKeyBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "name is required." }, 400);
    // Personal keys share the token alphabet but carry their own prefix so
    // the gateway can attribute them without a second lookup.
    const token = `emk_${mintModelGatewayToken().slice("emg_".length)}`;
    const key = await store.mintModelGatewayApiKey({
      userId: principal.userId,
      name: body.data.name,
      tokenHash: hashModelGatewayToken(token),
    });
    // The raw token is shown exactly once; only its hash persists.
    return c.json({ token, key });
  });

  app.get("/model-gateway/api-keys", async (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Authentication required" }, 401);
    const keys = (await store.listModelGatewayApiKeys()).filter(
      (key) => key.userId === principal.userId,
    );
    return c.json({ keys });
  });

  app.delete("/model-gateway/api-keys/:id", async (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Authentication required" }, 401);
    const keys = await store.listModelGatewayApiKeys();
    const key = keys.find((candidate) => candidate.id === c.req.param("id"));
    if (!key || key.userId !== principal.userId) {
      return c.json({ error: "Unknown API key." }, 404);
    }
    await store.revokeModelGatewayApiKey(key.id);
    return c.json({ ok: true });
  });
}

function publicProvider(provider: {
  id: string;
  providerId: string;
  name: string;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
}): Record<string, string> {
  return {
    id: provider.id,
    providerId: provider.providerId,
    name: provider.name,
    baseUrl: provider.baseUrl,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}
