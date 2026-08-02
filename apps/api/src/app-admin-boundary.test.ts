import { describe, expect, test } from "vitest";
import {
  createAuthApp,
  invite,
  signIn,
} from "./auth-routes.test-support.js";

// Ratchet-shaped walk: every route registered under the platform-operator
// prefixes must refuse a member session before its handler runs. New
// /system/* or /platform/* routes are covered automatically by enumeration.
describe("admin-only boundary", () => {
  test("every /system/* and /platform/* route refuses a member session with 403", async () => {
    const { app } = await createAuthApp();
    const { cookie: adminCookie } = await signIn(app);
    const issued = await invite(app, adminCookie, "walk-member@example.com");
    const accepted = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: new URL(issued.body.inviteUrl).searchParams.get("token")!,
        name: "Walk Member",
        password: "member-password",
      }),
    });
    expect(accepted.status).toBe(200);
    const { cookie: memberCookie } = await signIn(
      app,
      "walk-member@example.com",
      "member-password",
    );

    const operatorRoutes = app.routes
      .filter(
        (route) =>
          route.method !== "ALL" &&
          (route.path.startsWith("/system/") ||
            route.path.startsWith("/platform/")),
      )
      .map((route) => ({
        method: route.method,
        path: route.path.replace(/:(\w+)/g, "walk-$1"),
      }));
    const uniqueRoutes = [
      ...new Map(
        operatorRoutes.map((route) => [`${route.method} ${route.path}`, route]),
      ).values(),
    ];
    // Sanity: enumeration found the operator surface (19 method+path pairs
    // today); an empty walk must fail loudly, not pass vacuously.
    expect(uniqueRoutes.length).toBeGreaterThanOrEqual(10);

    for (const route of uniqueRoutes) {
      const response = await app.request(route.path, {
        method: route.method,
        headers: {
          cookie: memberCookie,
          "content-type": "application/json",
        },
        ...(route.method === "GET" ? {} : { body: "{}" }),
      });
      expect(
        { ...route, status: response.status },
      ).toEqual({ ...route, status: 403 });
      await expect(response.json()).resolves.toEqual({
        error: "Admin access required",
      });
    }

    // The gate must not over-block: the same walk under the admin session
    // never yields the boundary's 403.
    for (const route of uniqueRoutes) {
      const response = await app.request(route.path, {
        method: route.method,
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        ...(route.method === "GET" ? {} : { body: "{}" }),
      });
      expect({ ...route, status: response.status }).not.toEqual({
        ...route,
        status: 403,
      });
    }
  });
});
