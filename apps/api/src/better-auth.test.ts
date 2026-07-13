import { describe, expect, test } from "vitest";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createBetterAuthRuntime, SESSION_COOKIE_NAME } from "./auth.js";

function createTestRuntime() {
  const database = {
    user: [] as Array<Record<string, unknown>>,
    session: [],
    account: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
  };
  const runtime = createBetterAuthRuntime({
    database: memoryAdapter(database),
    baseURL: "http://localhost:4000",
    webOrigin: "http://localhost:3000",
    secret: "test-secret-with-at-least-thirty-two-characters",
  });
  return { database, runtime };
}

async function signIn(runtime: ReturnType<typeof createBetterAuthRuntime>, password = "admin-password") {
  const response = await runtime.handler(new Request("http://localhost:4000/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ email: "admin@example.com", password }),
  }));
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  return { cookie, response };
}

describe("Better Auth runtime", () => {
  test("bootstraps one default organization admin without resetting an established password", async () => {
    const { database, runtime } = createTestRuntime();

    await runtime.bootstrapDefaultAdmin({ email: "admin@example.com", name: "Admin", password: "admin-password" });
    await runtime.bootstrapDefaultAdmin({ email: "admin@example.com", name: "Admin", password: "replacement-password" });

    expect(database.user).toEqual([
      expect.objectContaining({ id: "user_local_admin", email: "admin@example.com" }),
    ]);
    expect(database.organization).toEqual([
      expect.objectContaining({ id: "team_local", slug: "eveland" }),
    ]);
    expect(database.member).toEqual([
      expect.objectContaining({ role: "admin", organizationId: "team_local" }),
    ]);
    expect(database.account).toEqual([
      expect.objectContaining({ providerId: "credential", password: expect.any(String) }),
    ]);
    expect((await signIn(runtime)).response.status).toBe(200);
    expect((await signIn(runtime, "replacement-password")).response.status).toBe(401);
  });

  test("uses Better Auth sessions and the stable Eveland cookie name", async () => {
    const { runtime } = createTestRuntime();
    await runtime.bootstrapDefaultAdmin({ email: "admin@example.com", name: "Admin", password: "admin-password" });

    const { cookie, response } = await signIn(runtime);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    await expect(runtime.authenticate(new Request("http://localhost:4000/projects", {
      headers: { cookie },
    }))).resolves.toMatchObject({ email: "admin@example.com", role: "admin" });
  });

  test("adopts the legacy project owner row as the configured admin", async () => {
    const { database, runtime } = createTestRuntime();
    const now = new Date();
    database.user.push({
      id: "user_local_admin",
      email: "local@eveland.dev",
      emailVerified: false,
      name: "Local Admin",
      role: "user",
      banned: false,
      createdAt: now,
      updatedAt: now,
    });

    await runtime.bootstrapDefaultAdmin({ email: "admin@example.com", name: "Admin", password: "admin-password" });

    expect(database.user).toEqual([
      expect.objectContaining({ id: "user_local_admin", email: "admin@example.com", name: "Admin" }),
    ]);
    expect(database.account).toHaveLength(1);
    expect((await signIn(runtime)).response.status).toBe(200);
  });

  test("uses the Organization plugin for seven-day invitations and memberships", async () => {
    const { database, runtime } = createTestRuntime();
    await runtime.bootstrapDefaultAdmin({ email: "admin@example.com", name: "Admin", password: "admin-password" });
    const { cookie } = await signIn(runtime);
    const request = new Request("http://localhost:4000/invitations", { headers: { cookie } });

    await expect(runtime.authenticate(request)).resolves.toMatchObject({ role: "admin" });

    const issued = await runtime.invite(request, "member@example.com");
    const accepted = await runtime.acceptInvitation({
      token: issued.token,
      name: "Member",
      password: "member-password",
    });

    expect(issued.invitation.role).toBe("member");
    expect(new Date(issued.invitation.expiresAt).getTime() - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1_000);
    expect(database.invitation).toEqual([
      expect.objectContaining({ id: issued.token, organizationId: "team_local", status: "accepted" }),
    ]);
    expect(database.member).toHaveLength(2);
    expect(accepted.principal).toMatchObject({ email: "member@example.com", role: "member" });
    expect(accepted.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=`);
  });
});
