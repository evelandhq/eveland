import {
  authAccounts,
  authSessions,
  authVerifications,
  invitations,
  teamMemberships,
  teams,
  users,
} from "@evelandhq/db/schema";
import { createPgliteTestStore } from "@evelandhq/db/test";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { describe, expect, onTestFinished, test } from "vitest";
import { createBetterAuthRuntime, invitationHandle, SESSION_COOKIE_NAME } from "./auth.js";

async function createTestRuntime(
  interceptAdapter?: (adapter: Record<string, unknown>) => Record<string, unknown>,
) {
  const database = await createPgliteTestStore();
  onTestFinished(() => database.close());
  const baseAdapter = drizzleAdapter(database.db, {
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
  });
  const databaseOption = interceptAdapter
    ? (options: unknown) =>
        interceptAdapter(
          (baseAdapter as unknown as (options: unknown) => Record<string, unknown>)(options),
        )
    : baseAdapter;
  const runtime = createBetterAuthRuntime({
    database: databaseOption as Parameters<typeof createBetterAuthRuntime>[0]["database"],
    baseURL: "http://localhost:4000",
    webOrigin: "http://localhost:3000",
    secret: "test-secret-with-at-least-thirty-two-characters",
  });
  return { database, runtime };
}

async function signIn(
  runtime: ReturnType<typeof createBetterAuthRuntime>,
  password = "admin-password",
) {
  const response = await runtime.handler(
    new Request("http://localhost:4000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ email: "admin@example.com", password }),
    }),
  );
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  return { cookie, response };
}

describe("Better Auth runtime", () => {
  test("bootstraps one default organization admin without resetting an established password", async () => {
    const { database, runtime } = await createTestRuntime();

    await runtime.bootstrapDefaultAdmin({
      email: "admin@example.com",
      name: "Admin",
      password: "admin-password",
    });
    await runtime.bootstrapDefaultAdmin({
      email: "admin@example.com",
      name: "Admin",
      password: "replacement-password",
    });

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
    await runtime.bootstrapDefaultAdmin({
      email: "admin@example.com",
      name: "Admin",
      password: "admin-password",
    });

    const { cookie, response } = await signIn(runtime);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    await expect(
      runtime.authenticate(
        new Request("http://localhost:4000/projects", {
          headers: { cookie },
        }),
      ),
    ).resolves.toMatchObject({ email: "admin@example.com", role: "admin" });
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

    await runtime.bootstrapDefaultAdmin({
      email: "admin@example.com",
      name: "Admin",
      password: "admin-password",
    });

    await expect(database.db.select().from(users)).resolves.toEqual([
      expect.objectContaining({
        id: "user_local_admin",
        email: "admin@example.com",
        name: "Admin",
      }),
    ]);
    await expect(database.db.select().from(authAccounts)).resolves.toHaveLength(1);
    expect((await signIn(runtime)).response.status).toBe(200);
  });

  test("uses the Organization plugin for seven-day invitations and memberships", async () => {
    const { database, runtime } = await createTestRuntime();
    await runtime.bootstrapDefaultAdmin({
      email: "admin@example.com",
      name: "Admin",
      password: "admin-password",
    });
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
    expect(new Date(issued.invitation.expiresAt).getTime() - Date.now()).toBeGreaterThan(
      6 * 24 * 60 * 60 * 1_000,
    );
    await expect(database.db.select().from(invitations)).resolves.toEqual([
      expect.objectContaining({
        id: issued.token,
        organizationId: "team_local",
        status: "accepted",
      }),
    ]);
    await expect(database.db.select().from(teamMemberships)).resolves.toHaveLength(2);
    expect(accepted.principal).toMatchObject({ email: "member@example.com", role: "member" });
    expect(accepted.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=`);
  });

  test("previews whether an invitation belongs to an existing account only after validating the token", async () => {
    const { database, runtime } = await createTestRuntime();
    await runtime.bootstrapDefaultAdmin({
      email: "admin@example.com",
      name: "Admin",
      password: "admin-password",
    });
    const { cookie } = await signIn(runtime);
    const request = new Request("http://localhost:4000/invitations", { headers: { cookie } });

    const fresh = await runtime.invite(request, "newcomer@example.com");
    await expect(runtime.previewInvitation(fresh.token)).resolves.toEqual({
      email: "newcomer@example.com",
      existingAccount: false,
    });

    const rejoining = await runtime.invite(request, "rejoiner@example.com");
    const accepted = await runtime.acceptInvitation({
      token: rejoining.token,
      name: "Rejoiner",
      password: "rejoiner-password",
    });
    await runtime.removeMember(request, accepted.principal.userId);
    const reissued = await runtime.invite(request, "rejoiner@example.com");
    await expect(runtime.previewInvitation(reissued.token)).resolves.toEqual({
      email: "rejoiner@example.com",
      existingAccount: true,
    });

    await expect(runtime.previewInvitation("invitation_unknown")).rejects.toMatchObject({
      message: "Invitation not found",
      status: 404,
    });
    await database.db.insert(invitations).values({
      id: "invitation_expired",
      organizationId: "team_local",
      email: "rejoiner@example.com",
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() - 60_000),
      inviterId: "user_local_admin",
    });
    await expect(runtime.previewInvitation("invitation_expired")).rejects.toMatchObject({
      message: "Invitation is no longer pending",
      status: 409,
    });
  });

  test("re-invited existing accounts rejoin with their current password and keep their profile", async () => {
    const { database, runtime } = await createTestRuntime();
    await runtime.bootstrapDefaultAdmin({
      email: "admin@example.com",
      name: "Admin",
      password: "admin-password",
    });
    const { cookie } = await signIn(runtime);
    const request = new Request("http://localhost:4000/invitations", { headers: { cookie } });

    const issued = await runtime.invite(request, "member@example.com");
    const accepted = await runtime.acceptInvitation({
      token: issued.token,
      name: "Original Name",
      password: "original-password",
    });
    await runtime.removeMember(request, accepted.principal.userId);
    const reissued = await runtime.invite(request, "member@example.com");

    // A "new" password must not sign the user in, reset the stored credential,
    // or consume the invitation.
    await expect(
      runtime.acceptInvitation({ token: reissued.token, password: "a-brand-new-password" }),
    ).rejects.toMatchObject({
      message: "Incorrect password for your existing account",
      status: 401,
    });
    const invitationRows = await database.db.select().from(invitations);
    expect(invitationRows.find((row) => row.id === reissued.token)).toMatchObject({
      status: "pending",
    });

    const rejoined = await runtime.acceptInvitation({
      token: reissued.token,
      name: "Attempted Rename",
      password: "original-password",
    });

    expect(rejoined.principal).toMatchObject({
      email: "member@example.com",
      name: "Original Name",
      role: "member",
    });
    await expect(database.db.select().from(teamMemberships)).resolves.toHaveLength(2);
    await expect(database.db.select().from(users)).resolves.toContainEqual(
      expect.objectContaining({ email: "member@example.com", name: "Original Name" }),
    );
  });

  test("new-account acceptance still requires a name and the password policy", async () => {
    const { runtime } = await createTestRuntime();
    await runtime.bootstrapDefaultAdmin({
      email: "admin@example.com",
      name: "Admin",
      password: "admin-password",
    });
    const { cookie } = await signIn(runtime);
    const request = new Request("http://localhost:4000/invitations", { headers: { cookie } });
    const issued = await runtime.invite(request, "newcomer@example.com");

    await expect(
      runtime.acceptInvitation({ token: issued.token, password: "newcomer-password" }),
    ).rejects.toMatchObject({ message: "Name is required", status: 400 });
    await expect(
      runtime.acceptInvitation({ token: issued.token, name: "Newcomer", password: "too-short" }),
    ).rejects.toMatchObject({
      message: "Password must be at least 12 characters",
      status: 400,
    });

    const accepted = await runtime.acceptInvitation({
      token: issued.token,
      name: "Newcomer",
      password: "newcomer-password",
    });
    expect(accepted.principal).toMatchObject({ email: "newcomer@example.com", role: "member" });
  });

  test("lists only invitations that can still be accepted", async () => {
    const { database, runtime } = await createTestRuntime();
    await runtime.bootstrapDefaultAdmin({
      email: "admin@example.com",
      name: "Admin",
      password: "admin-password",
    });
    const { cookie } = await signIn(runtime);
    const request = new Request("http://localhost:4000/invitations", { headers: { cookie } });

    const used = await runtime.invite(request, "used@example.com");
    await runtime.acceptInvitation({
      token: used.token,
      name: "Used",
      password: "member-password",
    });
    const revoked = await runtime.invite(request, "revoked@example.com");
    await runtime.revokeInvitation(request, invitationHandle(revoked.invitation.id));
    await database.db.insert(invitations).values({
      id: "invitation_stale",
      organizationId: "team_local",
      email: "stale@example.com",
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() - 60_000),
      inviterId: "user_local_admin",
    });
    const live = await runtime.invite(request, "live@example.com");

    await expect(runtime.listInvitations(request)).resolves.toEqual([
      expect.objectContaining({
        id: live.invitation.id,
        email: "live@example.com",
        status: "pending",
      }),
    ]);
    await expect(database.db.select().from(invitations)).resolves.toHaveLength(4);
  });
});

describe("last-admin concurrency", () => {
  // Forces the classic check-then-act interleaving deterministically: while
  // armed, writes against the member model wait until BOTH racing flows have
  // arrived (so both already passed their pre-write admin count), then both
  // proceed. Disarms after release so compensating writes pass through.
  function createMemberWriteBarrier(expected = 2) {
    let armed = false;
    let arrived = 0;
    const waiters: Array<() => void> = [];
    return {
      arm() {
        armed = true;
      },
      async pass(model: unknown) {
        if (!armed || model !== "member") return;
        arrived += 1;
        if (arrived >= expected) {
          armed = false;
          for (const release of waiters) release();
          return;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
      },
    };
  }

  async function createTwoAdminFixture(barrier: ReturnType<typeof createMemberWriteBarrier>) {
    const { database, runtime } = await createTestRuntime((adapter) => ({
      ...adapter,
      async update(input: { model: string }) {
        await barrier.pass(input.model);
        return (adapter.update as (input: unknown) => Promise<unknown>)(input);
      },
      async updateMany(input: { model: string }) {
        await barrier.pass(input.model);
        return (adapter.updateMany as (input: unknown) => Promise<unknown>)(input);
      },
      async delete(input: { model: string }) {
        await barrier.pass(input.model);
        return (adapter.delete as (input: unknown) => Promise<unknown>)(input);
      },
      async deleteMany(input: { model: string }) {
        await barrier.pass(input.model);
        return (adapter.deleteMany as (input: unknown) => Promise<unknown>)(input);
      },
    }));
    await runtime.bootstrapDefaultAdmin({
      email: "admin@example.com",
      name: "Admin",
      password: "admin-password",
    });
    const { cookie } = await signIn(runtime);
    const adminRequest = new Request("http://localhost:4000/members", { headers: { cookie } });
    const issued = await runtime.invite(adminRequest, "second-admin@example.com", "admin");
    const accepted = await runtime.acceptInvitation({
      token: issued.token,
      name: "Second Admin",
      password: "second-password-123",
    });
    const secondCookie = accepted.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const secondRequest = new Request("http://localhost:4000/members", {
      headers: { cookie: secondCookie },
    });
    const members = await runtime.listMembers(adminRequest);
    const firstId = members.find((member) => member.email === "admin@example.com")!.userId;
    const secondId = accepted.principal.userId;
    return { database, runtime, adminRequest, secondRequest, firstId, secondId };
  }

  test("concurrent mutual demotions can never demote the last admin", async () => {
    const barrier = createMemberWriteBarrier();
    const fixture = await createTwoAdminFixture(barrier);

    barrier.arm();
    await Promise.allSettled([
      fixture.runtime.updateMemberRole(fixture.adminRequest, fixture.secondId, "member"),
      fixture.runtime.updateMemberRole(fixture.secondRequest, fixture.firstId, "member"),
    ]);

    const rows = await fixture.database.db.select().from(teamMemberships);
    expect(
      rows.filter((row) => row.role === "admin").length,
      "the Team must keep at least one admin",
    ).toBeGreaterThanOrEqual(1);
  });

  test("concurrent mutual removals can never remove the last admin", async () => {
    const barrier = createMemberWriteBarrier();
    const fixture = await createTwoAdminFixture(barrier);

    barrier.arm();
    await Promise.allSettled([
      fixture.runtime.removeMember(fixture.adminRequest, fixture.secondId),
      fixture.runtime.removeMember(fixture.secondRequest, fixture.firstId),
    ]);

    const rows = await fixture.database.db.select().from(teamMemberships);
    expect(
      rows.filter((row) => row.role === "admin").length,
      "the Team must keep at least one admin",
    ).toBeGreaterThanOrEqual(1);
  });
});
