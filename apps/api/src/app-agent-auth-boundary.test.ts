import type { AuthPrincipal } from "@evelandhq/core/contracts";
import { createTestStore } from "@evelandhq/db/vitest";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createAgentAuthService } from "./agent-auth-service.js";
import { registerAgentAuthRoutes } from "./app-agent-auth-routes.js";

const appSecretKey = "0123456789abcdef0123456789abcdef";

describe("Agent authentication API boundary", () => {
  test("registers the route family against its focused service and persistence ports", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "focused-agent-auth-boundary",
      importKind: "zip",
    });
    const app = new Hono<{ Variables: { principal: AuthPrincipal } }>();
    const agentAuth = createAgentAuthService({
      store,
      appSecretKey,
      oidcCallbackUrl: "http://localhost:3000/agent-auth/oidc/callback",
    });
    registerAgentAuthRoutes({ app, store, agentAuth });

    const methods = await app.request("/api/agent-auth/methods");
    const connection = await app.request(`/api/projects/${project.id}/playground/connection`);

    expect(methods.status).toBe(200);
    await expect(methods.json()).resolves.toMatchObject({
      methods: expect.arrayContaining([
        expect.objectContaining({ method: "local-dev" }),
        expect.objectContaining({ method: "oidc", interactive: true }),
      ]),
    });
    expect(connection.status).toBe(200);
    await expect(connection.json()).resolves.toMatchObject({
      connection: {
        target: { kind: "managed-project", projectId: project.id },
        method: "local-dev",
        securityRevision: 1,
        config: {},
      },
      status: { state: "not_required" },
    });
  });
});
