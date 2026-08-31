import type { MiddlewareHandler } from "hono";
import type { AuthPrincipal } from "@evelandhq/core/contracts";
import type { createBetterAuthRuntime } from "./auth.js";
import type { ApiApp } from "./app-types.js";
import {
  acceptInvitationSchema,
  passwordResetCompleteSchema,
  passwordResetPreviewSchema,
  previewInvitationSchema,
} from "./app-schemas.js";
import { authErrorResponse, getSetCookies } from "./app-support.js";

type BetterAuthRuntime = ReturnType<typeof createBetterAuthRuntime>;

export type ControlPlaneAuthBoundaryPort = Pick<
  BetterAuthRuntime,
  | "handler"
  | "acceptInvitation"
  | "previewInvitation"
  | "previewPasswordReset"
  | "completePasswordReset"
  | "authenticate"
>;

const allowedAuthPaths = new Set([
  "/api/auth/sign-in/email",
  "/api/auth/sign-out",
  "/api/auth/get-session",
]);

export function registerControlPlaneAuthBoundary(input: {
  app: ApiApp;
  auth: ControlPlaneAuthBoundaryPort;
}) {
  const { app, auth } = input;

  // Allowlist, not denylist: Better Auth upgrades must not silently widen the
  // public control-plane surface. Password and team mutations go through
  // Eveland-owned routes that enforce the platform's security invariants.
  app.on(["GET", "POST"], "/api/auth/*", (c) => {
    const path = new URL(c.req.url).pathname;
    if (!allowedAuthPaths.has(path)) return c.notFound();
    return auth.handler(c.req.raw);
  });

  // The accept page renders profile creation for a new email and a sign-in
  // flow for an account that already exists (a removed member being
  // re-invited). POST keeps the single-use token out of URLs and access logs.
  app.post("/api/invitations/preview", async (c) => {
    const parsed = previewInvitationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid invitation preview",
          issues: parsed.error.issues,
        },
        400,
      );
    }
    try {
      return c.json(await auth.previewInvitation(parsed.data.token));
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });

  app.post("/api/invitations/accept", async (c) => {
    const parsed = acceptInvitationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid invitation acceptance",
          issues: parsed.error.issues,
        },
        400,
      );
    }
    try {
      const session = await auth.acceptInvitation(parsed.data);
      for (const cookie of getSetCookies(session.headers)) {
        c.header("set-cookie", cookie, { append: true });
      }
      return c.json({ member: session.principal });
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });

  // The reset page mirrors the accept page: account details render only after
  // the single-use token validates, and POST keeps the token out of URLs and
  // access logs. The raw Better Auth recovery endpoints stay 404'd above.
  app.post("/api/password-reset/preview", async (c) => {
    const parsed = passwordResetPreviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid password reset preview",
          issues: parsed.error.issues,
        },
        400,
      );
    }
    try {
      return c.json(await auth.previewPasswordReset(parsed.data.token));
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });

  app.post("/api/password-reset/complete", async (c) => {
    const parsed = passwordResetCompleteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid password reset",
          issues: parsed.error.issues,
        },
        400,
      );
    }
    try {
      await auth.completePasswordReset(parsed.data);
      return c.body(null, 204);
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });

  // Hono applies middleware only to routes registered after it. Keeping this
  // gate in the same registrar as the public entries makes their order atomic.
  app.use("*", async (c, next) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) {
      return c.json({ error: "Authentication required" }, 401);
    }
    c.set("principal", principal);
    await next();
  });
}

/**
 * Structural role gate for the platform-operator surface: every current and
 * future route under /api/system/* and /api/platform/* is admin-only here, before any
 * handler runs, so a new operator route cannot forget the check. Registered
 * (like the session boundary above) only when auth is configured; the
 * member-403 walk in app-admin-boundary.test.ts pins the whole surface.
 */
export function registerAdminOnlyBoundary(app: ApiApp): void {
  const adminOnly: MiddlewareHandler<{
    Variables: { principal: AuthPrincipal };
  }> = async (c, next) => {
    if (c.get("principal")?.role !== "admin") {
      return c.json({ error: "Admin access required" }, 403);
    }
    await next();
  };
  app.use("/api/system/*", adminOnly);
  app.use("/api/platform/*", adminOnly);
}
