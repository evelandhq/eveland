import type { createBetterAuthRuntime } from "./auth.js";
import {
  invitationSchema,
  memberRoleSchema,
  passwordChangeSchema,
  profileSchema,
} from "./app-schemas.js";
import {
  authErrorResponse,
  getSetCookies,
  publicInvitation,
} from "./app-support.js";
import type { ApiApp } from "./app-types.js";

type BetterAuthRuntime = ReturnType<typeof createBetterAuthRuntime>;

export type MemberRoutesAuthPort = Pick<
  BetterAuthRuntime,
  | "updateProfile"
  | "changePassword"
  | "listMembers"
  | "listInvitations"
  | "invite"
  | "reissueInvitation"
  | "revokeInvitation"
  | "updateMemberRole"
  | "removeMember"
>;

export function registerMemberRoutes(input: {
  app: ApiApp;
  auth: MemberRoutesAuthPort;
  webOrigin: string;
}) {
  const { app, auth, webOrigin } = input;

  app.get("/auth/session", (c) =>
    c.json({ member: c.get("principal") }),
  );

  app.patch("/profile", async (c) => {
    const parsed = profileSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid profile", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const updated = await auth.updateProfile(c.req.raw, parsed.data);
      for (const cookie of getSetCookies(updated.headers)) {
        c.header("set-cookie", cookie, { append: true });
      }
      return c.json({ member: updated.principal });
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });

  app.post("/profile/password", async (c) => {
    const parsed = passwordChangeSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid password change", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const headers = await auth.changePassword(c.req.raw, parsed.data);
      for (const cookie of getSetCookies(headers)) {
        c.header("set-cookie", cookie, { append: true });
      }
      return c.body(null, 204);
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });

  app.get("/members", async (c) =>
    c.json({ members: await auth.listMembers(c.req.raw) }),
  );

  app.get("/invitations", async (c) => {
    try {
      const invitations = await auth.listInvitations(c.req.raw);
      return c.json({ invitations: invitations.map(publicInvitation) });
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });

  app.post("/invitations", async (c) => {
    const parsed = invitationSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid invitation input", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const issued = await auth.invite(c.req.raw, parsed.data.email);
      return c.json(
        {
          invitation: publicInvitation(issued.invitation),
          inviteUrl: `${webOrigin}/accept-invite?token=${encodeURIComponent(issued.token)}`,
        },
        201,
      );
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });

  app.post("/invitations/:invitationId/resend", async (c) => {
    try {
      const issued = await auth.reissueInvitation(
        c.req.raw,
        c.req.param("invitationId"),
      );
      return c.json({
        invitation: publicInvitation(issued.invitation),
        inviteUrl: `${webOrigin}/accept-invite?token=${encodeURIComponent(issued.token)}`,
      });
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });

  app.delete("/invitations/:invitationId", async (c) => {
    try {
      const revoked = await auth.revokeInvitation(
        c.req.raw,
        c.req.param("invitationId"),
      );
      return revoked
        ? c.body(null, 204)
        : c.json({ error: "Invitation not found" }, 404);
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });

  app.patch("/members/:userId", async (c) => {
    const parsed = memberRoleSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid member role" }, 400);
    }
    try {
      const member = await auth.updateMemberRole(
        c.req.raw,
        c.req.param("userId"),
        parsed.data.role,
      );
      return c.json({ member });
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });

  app.delete("/members/:userId", async (c) => {
    try {
      const removed = await auth.removeMember(
        c.req.raw,
        c.req.param("userId"),
      );
      return removed
        ? c.body(null, 204)
        : c.json({ error: "Member not found" }, 404);
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });
}
