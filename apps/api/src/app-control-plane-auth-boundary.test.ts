import type { AuthPrincipal } from "@eveland/core/contracts";
import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { registerControlPlaneAuthBoundary } from "./app-control-plane-auth-boundary.js";
import { registerMemberRoutes } from "./app-member-routes.js";
import { registerSystemDiagnosticsRoutes } from "./app-system-diagnostics-routes.js";
import {
  createAuthTestContext,
  signIn,
} from "./auth-routes.test-support.js";

test("composes the exact public auth surface before the protected control plane", async () => {
  const { auth, store } = await createAuthTestContext();
  const app = new Hono<{ Variables: { principal: AuthPrincipal } }>();
  const configurationDiagnostics = vi.fn(async () => ({ components: [] }));

  registerControlPlaneAuthBoundary({ app, auth });
  registerMemberRoutes({
    app,
    auth,
    webOrigin: "http://localhost:3000",
  });
  registerSystemDiagnosticsRoutes({
    app,
    store,
    configurationDiagnostics,
    gatewayHealth: async () => ({
      status: "healthy",
      message: "Gateway is healthy.",
      observedAt: "2026-08-01T00:00:00.000Z",
    }),
  });
  app.get("/protected-probe", (c) =>
    c.json({ email: c.get("principal").email }),
  );

  expect((await app.request("/api/auth/get-session")).status).toBe(200);
  expect(
    (
      await app.request("/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(400);

  for (const path of [
    "/api/auth/sign-up/email",
    "/api/auth/change-password",
    "/api/auth/update-user",
    "/api/auth/organization/remove-member",
  ]) {
    expect(
      (
        await app.request(path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3000",
          },
          body: "{}",
        })
      ).status,
    ).toBe(404);
  }

  const anonymousControlRequests: Array<{
    path: string;
    init?: RequestInit;
  }> = [
    { path: "/auth/session" },
    {
      path: "/profile",
      init: {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not-json",
      },
    },
    {
      path: "/profile/password",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      },
    },
    { path: "/members" },
    {
      path: "/members/user_test",
      init: {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not-json",
      },
    },
    { path: "/members/user_test", init: { method: "DELETE" } },
    { path: "/invitations" },
    {
      path: "/invitations",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      },
    },
    {
      path: "/invitations/invitation_test/resend",
      init: { method: "POST" },
    },
    {
      path: "/invitations/invitation_test",
      init: { method: "DELETE" },
    },
    { path: "/system/configuration" },
    { path: "/protected-probe" },
  ];
  for (const { path, init } of anonymousControlRequests) {
    const response = await app.request(path, init);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required",
    });
  }
  expect(configurationDiagnostics).not.toHaveBeenCalled();

  const { cookie } = await signIn(app);
  await expect(
    (await app.request("/auth/session", { headers: { cookie } })).json(),
  ).resolves.toEqual({
    member: expect.objectContaining({
      email: "admin@example.com",
      role: "admin",
    }),
  });
  expect(
    (await app.request("/members", { headers: { cookie } })).status,
  ).toBe(200);
  expect(
    (
      await app.request("/system/configuration", {
        headers: { cookie },
      })
    ).status,
  ).toBe(200);
  expect(configurationDiagnostics).toHaveBeenCalledOnce();
  await expect(
    (await app.request("/protected-probe", { headers: { cookie } })).json(),
  ).resolves.toEqual({ email: "admin@example.com" });

  const signOut = await app.request("/api/auth/sign-out", {
    method: "POST",
    headers: { cookie, origin: "http://localhost:3000" },
  });
  expect(signOut.status).toBe(200);
  expect(
    (await app.request("/protected-probe", { headers: { cookie } })).status,
  ).toBe(401);
});
