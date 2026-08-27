import { describe, expect, test } from "vitest";
import { createAuthApp, invite, signIn } from "./auth-routes.test-support.js";

describe("control-plane auth routes", () => {
  test("keeps health and Better Auth public while rejecting anonymous control-plane requests", async () => {
    const { app } = await createAuthApp();

    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/api/auth/get-session")).status).toBe(200);
    const response = await app.request("/projects");
    const agentAuthMethods = await app.request("/agent-auth/methods");
    const canonicalPlayground = await app.request(
      "/projects/proj_unauthorized/playground/eve/v1/session",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Must authenticate first" }),
      },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Authentication required" });
    expect(agentAuthMethods.status).toBe(401);
    await expect(agentAuthMethods.json()).resolves.toEqual({
      error: "Authentication required",
    });
    expect(canonicalPlayground.status).toBe(401);
    await expect(canonicalPlayground.json()).resolves.toEqual({
      error: "Authentication required",
    });
  });

  test("blocks the raw change-password endpoint so session revocation cannot be skipped", async () => {
    const { app } = await createAuthApp();
    const { cookie } = await signIn(app);

    // Eveland's /profile/password wrapper forces revokeOtherSessions: true;
    // the raw endpoint lets the caller keep their own hijacked session alive.
    const response = await app.request("/api/auth/change-password", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({
        currentPassword: "admin-password-123",
        newPassword: "hijacker-password-456",
        revokeOtherSessions: false,
      }),
    });

    expect(response.status).toBe(404);
  });

  test("blocks public sign-up and direct organization writes", async () => {
    const { app } = await createAuthApp();
    const { cookie } = await signIn(app);

    expect(
      (
        await app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:3000" },
          body: JSON.stringify({
            email: "attacker@example.com",
            name: "Attacker",
            password: "attacker-password",
          }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request("/api/auth/organization/remove-member", {
          method: "POST",
          headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" },
          body: JSON.stringify({
            memberIdOrEmail: "admin@example.com",
            organizationId: "team_local",
          }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request("/api/auth/update-user", {
          method: "POST",
          headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" },
          body: JSON.stringify({ image: "data:image/svg+xml;base64,PHN2Zy8+" }),
        })
      ).status,
    ).toBe(404);
  });

  test("signs in through Better Auth and returns the current member", async () => {
    const { app } = await createAuthApp();

    const { response, cookie } = await signIn(app);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("eveland_session=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const session = await app.request("/auth/session", { headers: { cookie } });
    await expect(session.json()).resolves.toEqual({
      member: expect.objectContaining({ email: "admin@example.com", role: "admin" }),
    });
  });

  test("allows only administrators to read system configuration diagnostics", async () => {
    const { app } = await createAuthApp();
    const { cookie: adminCookie } = await signIn(app);
    const issued = await invite(app, adminCookie);
    const accepted = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: new URL(issued.body.inviteUrl).searchParams.get("token")!,
        name: "Member",
        password: "member-password",
      }),
    });
    const memberCookie = accepted.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    expect((await app.request("/system/configuration")).status).toBe(401);
    const adminResponse = await app.request("/system/configuration", {
      headers: { cookie: adminCookie },
    });
    const memberResponse = await app.request("/system/configuration", {
      headers: { cookie: memberCookie },
    });

    expect(adminResponse.status).toBe(200);
    await expect(adminResponse.json()).resolves.toEqual({ components: [] });
    expect(memberResponse.status).toBe(403);
    await expect(memberResponse.json()).resolves.toEqual({ error: "Admin access required" });
    expect((await app.request("/system/observability")).status).toBe(401);
    expect(
      (
        await app.request("/system/observability", {
          headers: { cookie: adminCookie },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/system/observability", {
          headers: { cookie: memberCookie },
        })
      ).status,
    ).toBe(403);
  });

  test("allows only administrators to read instance health diagnostics", async () => {
    const { app } = await createAuthApp();
    const { cookie: adminCookie } = await signIn(app);
    const issued = await invite(app, adminCookie, "health-member@example.com");
    const accepted = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: new URL(issued.body.inviteUrl).searchParams.get("token")!,
        name: "Member",
        password: "member-password",
      }),
    });
    const memberCookie = accepted.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    expect((await app.request("/system/health")).status).toBe(401);
    expect((await app.request("/system/health", { headers: { cookie: adminCookie } })).status).toBe(
      200,
    );
    expect(
      (await app.request("/system/health", { headers: { cookie: memberCookie } })).status,
    ).toBe(403);
  });

  test("allows only administrators to manage the shared Agent environment", async () => {
    const { app } = await createAuthApp();
    const { cookie: adminCookie } = await signIn(app);
    const issued = await invite(app, adminCookie, "profile-member@example.com");
    const accepted = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: new URL(issued.body.inviteUrl).searchParams.get("token")!,
        name: "Profile Member",
        password: "member-password",
      }),
    });
    const memberCookie = accepted.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const input = {
      entries: [{ key: "OPENAI_API_KEY", kind: "secret", value: "operator-secret" }],
    };

    expect((await app.request("/platform/shared-agent-environment")).status).toBe(401);
    const memberResponse = await app.request("/platform/shared-agent-environment", {
      headers: { cookie: memberCookie },
    });
    expect(memberResponse.status).toBe(403);
    await expect(memberResponse.json()).resolves.toEqual({ error: "Admin access required" });

    const adminResponse = await app.request("/platform/shared-agent-environment", {
      method: "PUT",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(adminResponse.status).toBe(200);
  });

  test("updates the signed-in profile and revokes other sessions when changing the password", async () => {
    const { app } = await createAuthApp();
    const { cookie } = await signIn(app);
    const { cookie: otherCookie } = await signIn(app);
    const image = "data:image/png;base64,iVBORw0KGgo=";

    const profile = await app.request("/profile", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Eveland Admin", image }),
    });

    expect(profile.status).toBe(200);
    await expect(profile.json()).resolves.toEqual({
      member: expect.objectContaining({
        email: "admin@example.com",
        image,
        name: "Eveland Admin",
        role: "admin",
      }),
    });
    await expect(
      (await app.request("/auth/session", { headers: { cookie } })).json(),
    ).resolves.toEqual({
      member: expect.objectContaining({ image, name: "Eveland Admin" }),
    });

    const password = await app.request("/profile/password", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        currentPassword: "admin-password",
        newPassword: "new-admin-password",
      }),
    });

    expect(password.status).toBe(204);
    expect((await app.request("/auth/session", { headers: { cookie: otherCookie } })).status).toBe(
      401,
    );
    expect((await signIn(app)).response.status).toBe(401);
    expect((await signIn(app, "admin@example.com", "new-admin-password")).response.status).toBe(
      200,
    );
  });

  test("persists a valid personal display timezone and returns it with the session", async () => {
    const { app } = await createAuthApp();
    const { cookie } = await signIn(app);

    const profile = await app.request("/profile", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Admin",
        image: null,
        displayTimezone: "Asia/Shanghai",
      }),
    });

    expect(profile.status).toBe(200);
    await expect(profile.json()).resolves.toEqual({
      member: expect.objectContaining({ displayTimezone: "Asia/Shanghai" }),
    });
    await expect(
      (await app.request("/auth/session", { headers: { cookie } })).json(),
    ).resolves.toEqual({
      member: expect.objectContaining({ displayTimezone: "Asia/Shanghai" }),
    });
  });

  test("rejects an invalid personal display timezone", async () => {
    const { app } = await createAuthApp();
    const { cookie } = await signIn(app);

    const profile = await app.request("/profile", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Admin",
        image: null,
        displayTimezone: "Mars/Olympus_Mons",
      }),
    });

    expect(profile.status).toBe(400);
  });

  test("rejects unsupported or oversized profile images", async () => {
    const { app } = await createAuthApp();
    const { cookie } = await signIn(app);

    const unsupported = await app.request("/profile", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", image: "data:image/svg+xml;base64,PHN2Zy8+" }),
    });
    const oversized = await app.request("/profile", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Admin",
        image: `data:image/png;base64,${"A".repeat(700_000)}`,
      }),
    });

    expect(unsupported.status).toBe(400);
    expect(oversized.status).toBe(400);
  });

  test("lets an admin invite and a new member accept without exposing credential material", async () => {
    const { app } = await createAuthApp();
    const { cookie: adminCookie } = await signIn(app);
    const issued = await invite(app, adminCookie);

    expect(issued.response.status).toBe(201);
    expect(issued.body).toMatchObject({
      invitation: { role: "member", status: "pending" },
      inviteUrl: expect.stringMatching(
        /^http:\/\/localhost:3000\/accept-invite\?token=invitation_/,
      ),
    });
    expect(JSON.stringify(issued.body)).not.toContain("password");

    const accepted = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: new URL(issued.body.inviteUrl).searchParams.get("token")!,
        name: "Member",
        password: "member-password",
      }),
    });
    const memberCookie = accepted.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    expect(accepted.status).toBe(200);
    const forbidden = await invite(app, memberCookie, "other@example.com");
    expect(forbidden.response.status).toBe(403);
    const members = await app.request("/members", { headers: { cookie: memberCookie } });
    await expect(members.json()).resolves.toMatchObject({
      members: [
        expect.objectContaining({ email: "admin@example.com", role: "admin" }),
        expect.objectContaining({ email: "member@example.com", role: "member" }),
      ],
    });
  });

  test("walks a removed member through an explicit rejoin with their existing password", async () => {
    const { app } = await createAuthApp();
    const { cookie: adminCookie } = await signIn(app);
    const issued = await invite(app, adminCookie, "rejoiner@example.com");
    const accepted = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: new URL(issued.body.inviteUrl).searchParams.get("token")!,
        name: "Rejoiner",
        password: "rejoiner-password",
      }),
    });
    expect(accepted.status).toBe(200);
    const members = await (
      await app.request("/members", { headers: { cookie: adminCookie } })
    ).json();
    const memberId = members.members.find(
      (member: { email: string }) => member.email === "rejoiner@example.com",
    ).userId as string;
    expect(
      (
        await app.request(`/members/${memberId}`, {
          method: "DELETE",
          headers: { cookie: adminCookie },
        })
      ).status,
    ).toBe(204);

    const reissued = await invite(app, adminCookie, "rejoiner@example.com");
    const token = new URL(reissued.body.inviteUrl).searchParams.get("token")!;

    // The public preview tells the accept page which flow to render, but only
    // for a valid pending token.
    const preview = await app.request("/invitations/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toEqual({
      email: "rejoiner@example.com",
      existingAccount: true,
    });
    expect(
      (
        await app.request("/invitations/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "invitation_guess" }),
        })
      ).status,
    ).toBe(404);

    const wrongPassword = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "a-brand-new-password" }),
    });
    expect(wrongPassword.status).toBe(401);
    await expect(wrongPassword.json()).resolves.toEqual({
      error: "Incorrect password for your existing account",
    });

    const rejoined = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "rejoiner-password" }),
    });
    expect(rejoined.status).toBe(200);
    const rejoinedCookie = rejoined.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    await expect(
      (await app.request("/auth/session", { headers: { cookie: rejoinedCookie } })).json(),
    ).resolves.toEqual({
      member: expect.objectContaining({
        email: "rejoiner@example.com",
        name: "Rejoiner",
        role: "member",
      }),
    });
  });

  test("protects the last admin and revokes a removed member's Better Auth sessions", async () => {
    const { app } = await createAuthApp();
    const { cookie: adminCookie } = await signIn(app);
    const membersBefore = await (
      await app.request("/members", { headers: { cookie: adminCookie } })
    ).json();
    const adminId = membersBefore.members[0].userId as string;

    expect(
      (
        await app.request(`/members/${adminId}`, {
          method: "DELETE",
          headers: { cookie: adminCookie },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.request(`/members/${adminId}`, {
          method: "PATCH",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ role: "member" }),
        })
      ).status,
    ).toBe(409);

    const issued = await invite(app, adminCookie);
    const accepted = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: new URL(issued.body.inviteUrl).searchParams.get("token")!,
        name: "Member",
        password: "member-password",
      }),
    });
    const memberCookie = accepted.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const members = await (
      await app.request("/members", { headers: { cookie: adminCookie } })
    ).json();
    const memberId = members.members.find(
      (member: { email: string }) => member.email === "member@example.com",
    ).userId as string;

    expect(
      (
        await app.request(`/members/${memberId}`, {
          method: "PATCH",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ role: "admin" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/members/${memberId}`, {
          method: "DELETE",
          headers: { cookie: adminCookie },
        })
      ).status,
    ).toBe(204);
    expect((await app.request("/auth/session", { headers: { cookie: memberCookie } })).status).toBe(
      401,
    );
  });

  test("rotates and revokes pending invitation links", async () => {
    const { app } = await createAuthApp();
    const { cookie } = await signIn(app);
    const issued = await invite(app, cookie);

    const reissued = await app.request(`/invitations/${issued.body.invitation.id}/resend`, {
      method: "POST",
      headers: { cookie },
    });
    expect(reissued.status).toBe(200);
    const reissuedBody = (await reissued.json()) as {
      invitation: { id: string };
      inviteUrl: string;
    };
    expect(reissuedBody.invitation.id).not.toBe(issued.body.invitation.id);
    const reissuedToken = new URL(reissuedBody.inviteUrl).searchParams.get("token")!;

    expect(
      (
        await app.request(`/invitations/${reissuedBody.invitation.id}`, {
          method: "DELETE",
          headers: { cookie },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await app.request("/invitations/accept", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: reissuedToken,
            name: "Member",
            password: "member-password",
          }),
        })
      ).status,
    ).toBe(409);
  });

  test("management responses carry an invitation handle, never the acceptance token", async () => {
    const { app } = await createAuthApp();
    const { cookie } = await signIn(app);
    const issued = await invite(app, cookie, "tokenless@example.com");
    const token = new URL(issued.body.inviteUrl).searchParams.get("token")!;

    // The raw token opens an account; it belongs only in inviteUrl, which
    // create/resend intentionally surface. Every serialized invitation --
    // create response and list -- exposes a derived handle instead.
    expect(issued.body.invitation.id).not.toBe(token);
    expect(JSON.stringify(issued.body.invitation)).not.toContain(token);
    const list = await app.request("/invitations", { headers: { cookie } });
    expect(list.status).toBe(200);
    const listBody = await list.text();
    expect(listBody).not.toContain(token);

    // The handle from the list remains a working management reference.
    const listed = (
      JSON.parse(listBody) as { invitations: { id: string; email: string }[] }
    ).invitations.find((candidate) => candidate.email === "tokenless@example.com");
    expect(listed).toBeDefined();
    expect(
      (await app.request(`/invitations/${listed!.id}`, { method: "DELETE", headers: { cookie } }))
        .status,
    ).toBe(204);
    // A revoked token no longer opens an account.
    expect(
      (
        await app.request("/invitations/accept", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, name: "Member", password: "member-password" }),
        })
      ).status,
    ).toBe(409);
  });

  test("keeps Better Auth's own recovery endpoints unroutable", async () => {
    const { app } = await createAuthApp();

    // Recovery goes through Eveland-owned /password-reset routes only; the
    // raw endpoints would bypass admin issuance and forced session revocation.
    for (const path of ["/api/auth/forget-password", "/api/auth/reset-password"]) {
      expect(
        (
          await app.request(path, {
            method: "POST",
            headers: { "content-type": "application/json", origin: "http://localhost:3000" },
            body: JSON.stringify({ email: "admin@example.com" }),
          })
        ).status,
      ).toBe(404);
    }
  });

  test("an admin-issued reset link recovers a locked-out member end to end", async () => {
    const { app } = await createAuthApp();
    const { cookie: adminCookie } = await signIn(app);
    const issued = await invite(app, adminCookie);
    const accepted = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: new URL(issued.body.inviteUrl).searchParams.get("token")!,
        name: "Member",
        password: "member-password",
      }),
    });
    const memberCookie = accepted.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const members = await (
      await app.request("/members", { headers: { cookie: adminCookie } })
    ).json();
    const memberId = members.members.find(
      (member: { email: string }) => member.email === "member@example.com",
    ).userId as string;

    // Members cannot issue reset links, not even for themselves.
    expect(
      (
        await app.request(`/members/${memberId}/password-reset`, {
          method: "POST",
          headers: { cookie: memberCookie },
        })
      ).status,
    ).toBe(403);

    const created = await app.request(`/members/${memberId}/password-reset`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(created.status).toBe(201);
    const reset = (await created.json()) as {
      resetUrl: string;
      expiresAt: string;
      email: string;
    };
    expect(reset.email).toBe("member@example.com");
    const resetToken = new URL(reset.resetUrl).searchParams.get("token")!;
    expect(reset.resetUrl).toContain("http://localhost:3000/reset-password?token=");

    const previewed = await app.request("/password-reset/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: resetToken }),
    });
    expect(previewed.status).toBe(200);
    await expect(previewed.json()).resolves.toEqual({ email: "member@example.com" });

    expect(
      (
        await app.request("/password-reset/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: resetToken, password: "a-replacement-password" }),
        })
      ).status,
    ).toBe(204);

    // Completion revoked every session and replaced the credential.
    expect((await app.request("/auth/session", { headers: { cookie: memberCookie } })).status).toBe(
      401,
    );
    expect((await signIn(app, "member@example.com", "member-password")).response.status).toBe(401);
    const recovered = await signIn(app, "member@example.com", "a-replacement-password");
    expect(recovered.response.status).toBe(200);

    // The consumed link is dead for both preview and completion.
    expect(
      (
        await app.request("/password-reset/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: resetToken }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request("/password-reset/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: resetToken, password: "another-new-password" }),
        })
      ).status,
    ).toBe(404);
  });
});
