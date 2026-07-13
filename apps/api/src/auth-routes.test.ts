import { describe, expect, test } from "vitest";
import { createMemoryStore } from "@eveland/db";
import { createApp } from "./app.js";
import { createAuthService, type PasswordHasher } from "./auth.js";

const hasher: PasswordHasher = {
  async hash(password) {
    return `hash:${password}`;
  },
  async verify(passwordHash, password) {
    return passwordHash === `hash:${password}`;
  },
};

async function createAuthApp() {
  const tokens = ["admin-session", "invite-token", "member-session"];
  const store = createMemoryStore();
  const auth = createAuthService(store, {
    hasher,
    now: () => new Date("2026-07-13T00:00:00.000Z"),
    generateToken: () => tokens.shift() ?? "fallback-token",
  });
  await auth.bootstrapDefaultAdmin({ email: "admin@example.com", name: "Admin", password: "admin-password" });
  return { app: createApp(store, { auth, webOrigin: "http://localhost:3000" }), store };
}

async function signIn(app: ReturnType<typeof createApp>, email = "admin@example.com", password = "admin-password") {
  const response = await app.request("/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { response, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "" };
}

describe("control-plane auth routes", () => {
  test("keeps health public and rejects anonymous control-plane requests", async () => {
    const { app } = await createAuthApp();

    expect((await app.request("/health")).status).toBe(200);
    const response = await app.request("/projects");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Authentication required" });
  });

  test("signs in with an http-only session cookie and returns the current member", async () => {
    const { app } = await createAuthApp();

    const { response, cookie } = await signIn(app);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("eveland_session=admin-session");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    const session = await app.request("/auth/session", { headers: { cookie } });
    await expect(session.json()).resolves.toEqual({
      member: expect.objectContaining({ email: "admin@example.com", role: "admin" }),
    });
  });

  test("lets an admin invite a member without exposing the stored token hash", async () => {
    const { app } = await createAuthApp();
    const { cookie } = await signIn(app);

    const response = await app.request("/invitations", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com" }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      invitation: { email: "member@example.com", role: "member", status: "pending" },
      inviteUrl: "http://localhost:3000/accept-invite?token=invite-token",
    });
    expect(JSON.stringify(body)).not.toContain("tokenHash");
  });

  test("accepts an invitation, starts a member session, and blocks member administration", async () => {
    const { app } = await createAuthApp();
    const { cookie: adminCookie } = await signIn(app);
    await app.request("/invitations", {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com" }),
    });

    const accepted = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "invite-token", name: "Member", password: "member-password" }),
    });
    const memberCookie = accepted.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    expect(accepted.status).toBe(200);
    const forbidden = await app.request("/invitations", {
      method: "POST",
      headers: { cookie: memberCookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "other@example.com" }),
    });
    expect(forbidden.status).toBe(403);

    const members = await app.request("/members", { headers: { cookie: memberCookie } });
    await expect(members.json()).resolves.toMatchObject({
      members: [
        expect.objectContaining({ email: "admin@example.com", role: "admin" }),
        expect.objectContaining({ email: "member@example.com", role: "member" }),
      ],
    });
  });

  test("protects the last admin and revokes a removed member's session", async () => {
    const { app } = await createAuthApp();
    const { cookie: adminCookie } = await signIn(app);
    const membersBefore = await (await app.request("/members", { headers: { cookie: adminCookie } })).json();
    const adminId = membersBefore.members[0].userId as string;

    const lastAdmin = await app.request(`/members/${adminId}`, {
      method: "DELETE",
      headers: { cookie: adminCookie },
    });
    expect(lastAdmin.status).toBe(409);

    await app.request("/invitations", {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com" }),
    });
    const accepted = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "invite-token", name: "Member", password: "member-password" }),
    });
    const memberCookie = accepted.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const members = await (await app.request("/members", { headers: { cookie: adminCookie } })).json();
    const memberId = members.members.find((member: { email: string }) => member.email === "member@example.com").userId as string;

    const promoted = await app.request(`/members/${memberId}`, {
      method: "PATCH",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(promoted.status).toBe(200);

    const removed = await app.request(`/members/${memberId}`, { method: "DELETE", headers: { cookie: adminCookie } });
    expect(removed.status).toBe(204);
    expect((await app.request("/auth/session", { headers: { cookie: memberCookie } })).status).toBe(401);
  });

  test("rotates and revokes pending invitation links", async () => {
    const { app } = await createAuthApp();
    const { cookie } = await signIn(app);
    const issued = await app.request("/invitations", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com" }),
    });
    const invitationId = ((await issued.json()).invitation as { id: string }).id;

    const reissued = await app.request(`/invitations/${invitationId}/resend`, { method: "POST", headers: { cookie } });
    expect(reissued.status).toBe(200);
    await expect(reissued.json()).resolves.toMatchObject({
      inviteUrl: "http://localhost:3000/accept-invite?token=member-session",
    });

    const revoked = await app.request(`/invitations/${invitationId}`, { method: "DELETE", headers: { cookie } });
    expect(revoked.status).toBe(204);
    const acceptRevoked = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "member-session", name: "Member", password: "member-password" }),
    });
    expect(acceptRevoked.status).toBe(409);
  });
});
