import type { createBetterAuthRuntime } from "./auth.js";
import type { ApiApp } from "./app-types.js";
import { acceptInvitationSchema } from "./app-schemas.js";
import { authErrorResponse, getSetCookies } from "./app-support.js";

type BetterAuthRuntime = ReturnType<typeof createBetterAuthRuntime>;

export type ControlPlaneAuthBoundaryPort = Pick<
  BetterAuthRuntime,
  "handler" | "acceptInvitation" | "authenticate"
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

  app.post("/invitations/accept", async (c) => {
    const parsed = acceptInvitationSchema.safeParse(
      await c.req.json().catch(() => null),
    );
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
