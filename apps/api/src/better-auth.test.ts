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
import { describe, expect, onTestFinished, test } from "vitest";
import { createBetterAuthRuntime, SESSION_COOKIE_NAME } from "./auth.js";

async function createTestRuntime() {
  const database = await createPgliteTestStore();
  onTestFinished(() => database.close());
  const runtime = createBetterAuthRuntime({
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
    const { database, runtime } = await createTestRuntime();

    await runtime.bootstrapDefaultAdmin({ email: "admin@example.com", name: "Admin", password: "admin-password" });
    await runtime.bootstrapDefaultAdmin({ email: "admin@example.com", name: "Admin", password: "replacement-password" });

    await expect(database.db.select().from(users)).resolves.toEqual([
      expect.objectContaining({ id: "user_local_admin", email: "admin@example.com" }),
    ]);
    await expect(database.db.select().from(teams)).resolves.toEqual([
      expect.objectContaining({ id: "team_local", slug: "eveland" }),
    ]);
    await expect(database.db.select().from(teamMemberships)).resolves.toEqual([
      expect.objectContaining({ role: "admin", organizationId: "team_local" }),
    ]);
    await expect(database.db.select().from(authAccounts)).resolves.toEqual([
      expect.objectContaining({ providerId: "credential", password: expect.any(String) }),
    ]);
    expect((await signIn(runtime)).response.status).toBe(200);
    expect((await signIn(runtime, "replacement-password")).response.status).toBe(401);
  });

  test("uses Better Auth sessions and the stable Eveland cookie name", async () => {
    const { runtime } = await createTestRuntime();
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
    const { database, runtime } = await createTestRuntime();
    const now = new Date();
    await database.db.insert(users).values({
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

    await expect(database.db.select().from(users)).resolves.toEqual([
      expect.objectContaining({ id: "user_local_admin", email: "admin@example.com", name: "Admin" }),
    ]);
    await expect(database.db.select().from(authAccounts)).resolves.toHaveLength(1);
    expect((await signIn(runtime)).response.status).toBe(200);
  });

  test("uses the Organization plugin for seven-day invitations and memberships", async () => {
    const { database, runtime } = await createTestRuntime();
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
    await expect(database.db.select().from(invitations)).resolves.toEqual([
      expect.objectContaining({ id: issued.token, organizationId: "team_local", status: "accepted" }),
    ]);
    await expect(database.db.select().from(teamMemberships)).resolves.toHaveLength(2);
    expect(accepted.principal).toMatchObject({ email: "member@example.com", role: "member" });
    expect(accepted.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=`);
  });
});
