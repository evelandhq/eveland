import { describe, expect, test } from "vitest";
import { createMemoryStore } from "@eveland/db";
import { argon2PasswordHasher, createAuthService, serializeSessionCookie, type PasswordHasher } from "./auth.js";

const hasher: PasswordHasher = {
  async hash(password) {
    return `hash:${password}`;
  },
  async verify(passwordHash, password) {
    return passwordHash === `hash:${password}`;
  },
};

function createTestAuth() {
  const tokens = ["session-token", "invitation-token", "member-session"];
  const store = createMemoryStore();
  const auth = createAuthService(store, {
    hasher,
    now: () => new Date("2026-07-13T00:00:00.000Z"),
    generateToken: () => tokens.shift() ?? "fallback-token",
  });
  return { auth, store };
}

describe("control-plane auth service", () => {
  test("can share a secure session cookie with the web subdomain", () => {
    const cookie = serializeSessionCookie("token", "2026-08-13T00:00:00.000Z", true, ".example.com");

    expect(cookie).toContain("Domain=.example.com");
    expect(cookie).toContain("Secure");
  });

  test("hashes real passwords with Argon2id", async () => {
    const passwordHash = await argon2PasswordHasher.hash("correct horse battery staple");

    expect(passwordHash).toContain("$argon2id$");
    await expect(argon2PasswordHasher.verify(passwordHash, "correct horse battery staple")).resolves.toBe(true);
    await expect(argon2PasswordHasher.verify(passwordHash, "wrong password")).resolves.toBe(false);
  });

  test("bootstraps and signs in the configured default admin", async () => {
    const { auth } = createTestAuth();
    await auth.bootstrapDefaultAdmin({
      email: "admin@example.com",
      name: "Admin",
      password: "correct horse battery staple",
    });

    const signedIn = await auth.signIn("ADMIN@example.com", "correct horse battery staple");

    expect(signedIn.principal).toMatchObject({ email: "admin@example.com", role: "admin" });
    const request = new Request("http://localhost/projects", {
      headers: { cookie: `eveland_session=${signedIn.token}` },
    });
    await expect(auth.authenticate(request)).resolves.toMatchObject({ email: "admin@example.com", role: "admin" });
  });

  test("rejects an invalid password without creating a session", async () => {
    const { auth, store } = createTestAuth();
    await auth.bootstrapDefaultAdmin({ email: "admin@example.com", name: "Admin", password: "correct-password" });

    await expect(auth.signIn("admin@example.com", "wrong-password")).rejects.toThrow("Invalid email or password");
    await expect(store.getAuthSession("session-token")).resolves.toBeNull();
  });

  test("lets an admin issue and a new member accept a seven-day invitation", async () => {
    const { auth } = createTestAuth();
    await auth.bootstrapDefaultAdmin({ email: "admin@example.com", name: "Admin", password: "admin-password" });
    const admin = (await auth.signIn("admin@example.com", "admin-password")).principal;

    const issued = await auth.invite(admin, "member@example.com");
    const accepted = await auth.acceptInvitation({
      token: issued.token,
      name: "Team Member",
      password: "member-password",
    });

    expect(issued.invitation.expiresAt).toBe("2026-07-20T00:00:00.000Z");
    expect(accepted.principal).toMatchObject({ email: "member@example.com", role: "member" });
    expect(accepted.token).toBe("member-session");
  });

  test("prevents a regular member from inviting another member", async () => {
    const { auth } = createTestAuth();
    await auth.bootstrapDefaultAdmin({ email: "admin@example.com", name: "Admin", password: "admin-password" });
    const admin = (await auth.signIn("admin@example.com", "admin-password")).principal;
    const issued = await auth.invite(admin, "member@example.com");
    const member = (await auth.acceptInvitation({ token: issued.token, name: "Member", password: "member-password" })).principal;

    await expect(auth.invite(member, "other@example.com")).rejects.toThrow("Admin access required");
  });

  test("requires an existing removed member's current password before restoring access", async () => {
    const { auth } = createTestAuth();
    await auth.bootstrapDefaultAdmin({ email: "admin@example.com", name: "Admin", password: "admin-password" });
    const admin = (await auth.signIn("admin@example.com", "admin-password")).principal;
    const firstInvite = await auth.invite(admin, "member@example.com");
    const member = (await auth.acceptInvitation({ token: firstInvite.token, name: "Member", password: "member-password" })).principal;
    await auth.removeMember(admin, member.userId);
    const secondInvite = await auth.invite(admin, "member@example.com");

    await expect(
      auth.acceptInvitation({ token: secondInvite.token, name: "Member", password: "wrong-password" }),
    ).rejects.toThrow("Invalid email or password");
  });
});
