import { createDatabase } from "@eveland/db/client";
import { authAccounts, authSessions, authVerifications, invitations, teamMemberships, teams, users } from "@eveland/db/schema";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { afterAll, describe, expect, test } from "vitest";
import { createBetterAuthRuntime } from "./auth.js";

const databaseUrl = process.env.EVELAND_POSTGRES_TEST_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

describe.skipIf(!database)("Better Auth Postgres integration", () => {
  test("bootstraps, signs in, and accepts an organization invitation on the migrated schema", async () => {
    const runtime = createBetterAuthRuntime({
      database: drizzleAdapter(database!.db, {
        provider: "pg",
        schema: {
          user: users,
          session: authSessions,
          account: authAccounts,
          verification: authVerifications,
          organization: teams,
          member: teamMemberships,
          invitation: invitations,
        },
      }),
      baseURL: "http://localhost:4000",
      webOrigin: "http://localhost:3000",
      secret: "postgres-integration-secret-32-characters",
    });

    await runtime.bootstrapDefaultAdmin({
      email: "admin@example.com",
      name: "Admin",
      password: "admin-password",
    });

    const signIn = await runtime.handler(new Request("http://localhost:4000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ email: "admin@example.com", password: "admin-password" }),
    }));
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get("set-cookie")!.split(";", 1)[0]!;
    const adminRequest = new Request("http://localhost:4000/members", { headers: { cookie } });

    const email = `member-${Date.now()}@example.com`;
    const issued = await runtime.invite(adminRequest, email);
    await expect(runtime.acceptInvitation({
      token: issued.token,
      name: "Postgres Member",
      password: "member-password",
    })).resolves.toMatchObject({ principal: { email, role: "member" } });

    await expect(runtime.listMembers(adminRequest)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ email: "admin@example.com", role: "admin" }),
      expect.objectContaining({ email, role: "member" }),
    ]));
    await expect(database!.db.select().from(authAccounts)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: "credential", password: expect.any(String) }),
    ]));
    const legacyProject = await database!.db.query.projects.findFirst({
      where: (table, { eq }) => eq(table.id, "project_legacy"),
    });
    if (legacyProject) expect(legacyProject.teamId).toBe("team_local");
  }, 30_000);
});
