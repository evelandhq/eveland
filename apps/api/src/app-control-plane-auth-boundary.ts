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
import { isRequestAllowedForScopes } from "./cli-auth.js";

type BetterAuthRuntime = ReturnType<typeof createBetterAuthRuntime>;

export type ControlPlaneAuthBoundaryPort = Pick<
  BetterAuthRuntime,
  | "handler"
  | "acceptInvitation"
  | "previewInvitation"
  | "previewPasswordReset"
  | "completePasswordReset"
  | "authenticate"
  | "authenticateAccessToken"
  | "trimDeviceCodes"
>;

// Source throttle for the one unauthenticated write endpoint. The Agent
// Gateway is the only public listener and stamps x-forwarded-for, so the
// first hop is trustworthy; direct loopback callers (dev) share one bucket.
// State is per app instance — a restart forgives, which is fine for a
// throttle whose job is raising the cost of flooding, not perfect fairness.
const DEVICE_CODE_RATE_LIMIT = { max: 10, windowMs: 10 * 60_000 };

export function createDeviceCodeRateLimiter(now: () => number = Date.now) {
  const requests = new Map<string, number[]>();
  return (source: string): boolean => {
    const cutoff = now() - DEVICE_CODE_RATE_LIMIT.windowMs;
    const recent = (requests.get(source) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= DEVICE_CODE_RATE_LIMIT.max) {
      requests.set(source, recent);
      return false;
    }
    recent.push(now());
    requests.set(source, recent);
    if (requests.size > 10_000) {
      for (const [key, timestamps] of requests) {
        if (!timestamps.some((timestamp) => timestamp > cutoff)) requests.delete(key);
      }
    }
    return true;
  };
}

const allowedAuthPaths = new Set([
  "/api/auth/sign-in/email",
  "/api/auth/sign-out",
  "/api/auth/get-session",
  // RFC 8628 device authorization for `eveland login`. The CLI requests a
  // code, the Dashboard's /device page previews and approves/denies it (the
  // approve/deny endpoints require the browser session), and the CLI redeems
  // the approved code for a scoped OAuth access token at the token endpoint.
  "/api/auth/device/code",
  "/api/auth/device",
  "/api/auth/device/approve",
  "/api/auth/device/deny",
  "/api/auth/oauth2/token",
]);

export function registerControlPlaneAuthBoundary(input: {
  app: ApiApp;
  auth: ControlPlaneAuthBoundaryPort;
}) {
  const { app, auth } = input;

  // Allowlist, not denylist: Better Auth upgrades must not silently widen the
  // public control-plane surface. Password and team mutations go through
  // Eveland-owned routes that enforce the platform's security invariants.
  const allowDeviceCodeRequest = createDeviceCodeRateLimiter();
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname;
    if (!allowedAuthPaths.has(path)) return c.notFound();
    if (path === "/api/auth/device/code") {
      const source = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "direct";
      if (!allowDeviceCodeRequest(source)) {
        return c.json(
          {
            error: "slow_down",
            error_description:
              "Too many device authorization requests from this address. Try again shortly.",
          },
          429,
        );
      }
      const response = await auth.handler(c.req.raw);
      // Post-insert enforcement keeps the code table bounded without a
      // check-then-insert race; see trimDeviceCodes for the eviction policy.
      if (response.ok) await auth.trimDeviceCodes();
      return response;
    }
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
  // An Authorization header selects the CLI token path exclusively: an
  // explicit credential is never silently downgraded to the cookie session.
  app.use("*", async (c, next) => {
    const principal = c.req.raw.headers.get("authorization")
      ? await auth.authenticateAccessToken(c.req.raw)
      : await auth.authenticate(c.req.raw);
    if (!principal) {
      return c.json({ error: "Authentication required" }, 401);
    }
    if (
      principal.tokenScopes &&
      !isRequestAllowedForScopes(c.req.method, new URL(c.req.url).pathname, principal.tokenScopes)
    ) {
      return c.json({ error: "Token scope does not allow this request" }, 403);
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
