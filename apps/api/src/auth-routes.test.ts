import { describe, expect, onTestFinished, test } from "vitest";
import {
  authAccounts,
  authDeviceCodes,
  authSessions,
  authVerifications,
  invitations,
  teamMemberships,
  teams,
  users,
} from "@eveland/db/schema";
import { createPgliteTestStore } from "@eveland/db/test";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createApp } from "./app.js";
import { createBetterAuthRuntime } from "./auth.js";

async function createAuthApp() {
  const database = await createPgliteTestStore();
  onTestFinished(() => database.close());
  const auth = createBetterAuthRuntime({
    database: drizzleAdapter(database.db, {
      provider: "pg",
      schema: {
        user: users,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        organization: teams,
        member: teamMemberships,
        invitation: invitations,
        deviceCode: authDeviceCodes,
      },
    }),
    baseURL: "http://localhost:4000",
    webOrigin: "http://localhost:3000",
    secret: "test-secret-with-at-least-thirty-two-characters",
  });
  await auth.bootstrapDefaultAdmin({ email: "admin@example.com", name: "Admin", password: "admin-password" });
  return {
    app: createApp(database.store, {
      auth,
      webOrigin: "http://localhost:3000",
      configurationDiagnostics: async () => ({ components: [] }),
    }),
    store: database.store,
  };
}

async function signIn(app: ReturnType<typeof createApp>, email = "admin@example.com", password = "admin-password") {
  const response = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ email, password }),
  });
  return { response, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "" };
}

async function invite(app: ReturnType<typeof createApp>, cookie: string, email = "member@example.com") {
  const response = await app.request("/invitations", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return { response, body: await response.json() as { invitation: { id: string }; inviteUrl: string } };
}

describe("control-plane auth routes", () => {
  test("keeps health and Better Auth public while rejecting anonymous control-plane requests", async () => {
    const { app } = await createAuthApp();

    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/api/auth/get-session")).status).toBe(200);
    const response = await app.request("/projects");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Authentication required" });
  });

  test("blocks public sign-up and direct organization writes", async () => {
    const { app } = await createAuthApp();
    const { cookie } = await signIn(app);

    expect((await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ email: "attacker@example.com", name: "Attacker", password: "attacker-password" }),
    })).status).toBe(404);
    expect((await app.request("/api/auth/organization/remove-member", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ memberIdOrEmail: "admin@example.com", organizationId: "team_local" }),
    })).status).toBe(404);
    expect((await app.request("/api/auth/update-user", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ image: "data:image/svg+xml;base64,PHN2Zy8+" }),
    })).status).toBe(404);
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

  test("authorizes the CLI through OAuth device flow and accepts its bearer session", async () => {
    const { app } = await createAuthApp();
    const issued = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "eveland-cli" }),
    });

    expect(issued.status).toBe(200);
    const codes = await issued.json() as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    };
    expect(codes).toMatchObject({
      device_code: expect.any(String),
      user_code: expect.any(String),
      verification_uri: "http://localhost:3000/auth/device",
      verification_uri_complete: expect.stringContaining(
        "http://localhost:3000/auth/device?user_code=",
      ),
      expires_in: 600,
      interval: 5,
    });

    const { cookie } = await signIn(app);
    const verified = await app.request(
      `/api/auth/device?user_code=${encodeURIComponent(codes.user_code)}`,
      { headers: { cookie } },
    );
    expect(verified.status).toBe(200);
    const approved = await app.request("/api/auth/device/approve", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ userCode: codes.user_code }),
    });
    expect(approved.status).toBe(200);

    const exchanged = await app.request("/api/auth/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: codes.device_code,
        client_id: "eveland-cli",
      }),
    });
    expect(exchanged.status).toBe(200);
    const token = await exchanged.json() as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(token).toMatchObject({
      access_token: expect.any(String),
      token_type: "Bearer",
      expires_in: expect.any(Number),
    });

    const session = await app.request("/auth/session", {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toEqual({
      member: expect.objectContaining({ email: "admin@example.com", role: "admin" }),
    });

    const invalidClient = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "untrusted-cli" }),
    });
    expect(invalidClient.status).toBe(400);
  });

  test("allows only administrators to read system configuration diagnostics", async () => {
    const { app } = await createAuthApp();
    const { cookie: adminCookie } = await signIn(app);
    const issued = await invite(app, adminCookie);
    const accepted = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: issued.body.invitation.id, name: "Member", password: "member-password" }),
    });
    const memberCookie = accepted.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    expect((await app.request("/system/configuration")).status).toBe(401);
    const adminResponse = await app.request("/system/configuration", { headers: { cookie: adminCookie } });
    const memberResponse = await app.request("/system/configuration", { headers: { cookie: memberCookie } });

    expect(adminResponse.status).toBe(200);
    await expect(adminResponse.json()).resolves.toEqual({ components: [] });
    expect(memberResponse.status).toBe(403);
    await expect(memberResponse.json()).resolves.toEqual({ error: "Admin access required" });
  });

  test("allows only administrators to read instance health diagnostics", async () => {
    const { app } = await createAuthApp();
    const { cookie: adminCookie } = await signIn(app);
    const issued = await invite(app, adminCookie, "health-member@example.com");
    const accepted = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: issued.body.invitation.id, name: "Member", password: "member-password" }),
    });
    const memberCookie = accepted.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    expect((await app.request("/system/health")).status).toBe(401);
    expect((await app.request("/system/health", { headers: { cookie: adminCookie } })).status).toBe(200);
    expect((await app.request("/system/health", { headers: { cookie: memberCookie } })).status).toBe(403);
  });

  test("allows only administrators to manage the shared Agent environment", async () => {
    const { app } = await createAuthApp();
    const { cookie: adminCookie } = await signIn(app);
    const issued = await invite(app, adminCookie, "profile-member@example.com");
    const accepted = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: issued.body.invitation.id, name: "Profile Member", password: "member-password" }),
    });
    const memberCookie = accepted.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const input = { entries: [{ key: "OPENAI_API_KEY", kind: "secret", value: "operator-secret" }] };

    expect((await app.request("/platform/shared-agent-environment")).status).toBe(401);
    const memberResponse = await app.request("/platform/shared-agent-environment", { headers: { cookie: memberCookie } });
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
    await expect((await app.request("/auth/session", { headers: { cookie } })).json()).resolves.toEqual({
      member: expect.objectContaining({ image, name: "Eveland Admin" }),
    });

    const password = await app.request("/profile/password", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "admin-password", newPassword: "new-admin-password" }),
    });

    expect(password.status).toBe(204);
    expect((await app.request("/auth/session", { headers: { cookie: otherCookie } })).status).toBe(401);
    expect((await signIn(app)).response.status).toBe(401);
    expect((await signIn(app, "admin@example.com", "new-admin-password")).response.status).toBe(200);
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
      body: JSON.stringify({ name: "Admin", image: `data:image/png;base64,${"A".repeat(700_000)}` }),
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
      inviteUrl: expect.stringMatching(/^http:\/\/localhost:3000\/auth\/accept-invite\?token=invitation_/),
    });
    expect(JSON.stringify(issued.body)).not.toContain("password");

    const accepted = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: issued.body.invitation.id, name: "Member", password: "member-password" }),
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

  test("protects the last admin and revokes a removed member's Better Auth sessions", async () => {
    const { app } = await createAuthApp();
    const { cookie: adminCookie } = await signIn(app);
    const membersBefore = await (await app.request("/members", { headers: { cookie: adminCookie } })).json();
    const adminId = membersBefore.members[0].userId as string;

    expect((await app.request(`/members/${adminId}`, { method: "DELETE", headers: { cookie: adminCookie } })).status).toBe(409);

    const issued = await invite(app, adminCookie);
    const accepted = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: issued.body.invitation.id, name: "Member", password: "member-password" }),
    });
    const memberCookie = accepted.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const members = await (await app.request("/members", { headers: { cookie: adminCookie } })).json();
    const memberId = members.members.find((member: { email: string }) => member.email === "member@example.com").userId as string;

    expect((await app.request(`/members/${memberId}`, {
      method: "PATCH",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    })).status).toBe(200);
    expect((await app.request(`/members/${memberId}`, { method: "DELETE", headers: { cookie: adminCookie } })).status).toBe(204);
    expect((await app.request("/auth/session", { headers: { cookie: memberCookie } })).status).toBe(401);
  });

  test("rotates and revokes pending invitation links", async () => {
    const { app } = await createAuthApp();
    const { cookie } = await signIn(app);
    const issued = await invite(app, cookie);

    const reissued = await app.request(`/invitations/${issued.body.invitation.id}/resend`, { method: "POST", headers: { cookie } });
    expect(reissued.status).toBe(200);
    const reissuedBody = await reissued.json() as { invitation: { id: string }; inviteUrl: string };
    expect(reissuedBody.invitation.id).not.toBe(issued.body.invitation.id);
    expect(reissuedBody.inviteUrl).toContain(reissuedBody.invitation.id);

    expect((await app.request(`/invitations/${reissuedBody.invitation.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
    expect((await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: reissuedBody.invitation.id, name: "Member", password: "member-password" }),
    })).status).toBe(409);
  });
});
