import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./store.js";

const defaultAdmin = {
  email: "admin@example.com",
  name: "Admin",
  passwordHash: "hash:admin-password",
};

describe("team membership and authentication store", () => {
  test("bootstraps one default team admin idempotently", async () => {
    const store = createMemoryStore();

    const first = await store.ensureDefaultAdmin(defaultAdmin);
    const second = await store.ensureDefaultAdmin(defaultAdmin);

    expect(second).toEqual(first);
    await expect(store.listMembers()).resolves.toEqual([
      expect.objectContaining({
        userId: first.id,
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
      }),
    ]);
  });

  test("creates and accepts a normalized single-use invitation", async () => {
    const store = createMemoryStore();
    const admin = await store.ensureDefaultAdmin(defaultAdmin);
    const invitation = await store.createInvitation({
      email: "  MEMBER@Example.com ",
      role: "member",
      tokenHash: "token-hash",
      expiresAt: "2026-07-20T00:00:00.000Z",
      invitedByUserId: admin.id,
    });

    expect(invitation.email).toBe("member@example.com");
    const accepted = await store.acceptInvitation({
      tokenHash: "token-hash",
      name: "Team Member",
      passwordHash: "hash:member-password",
      acceptedAt: "2026-07-13T00:00:00.000Z",
    });

    expect(accepted).toMatchObject({ email: "member@example.com", role: "member" });
    await expect(
      store.acceptInvitation({
        tokenHash: "token-hash",
        name: "Again",
        passwordHash: "hash:again",
        acceptedAt: "2026-07-13T00:01:00.000Z",
      }),
    ).rejects.toThrow("Invitation is no longer pending");
  });

  test("refuses an expired invitation", async () => {
    const store = createMemoryStore();
    const admin = await store.ensureDefaultAdmin(defaultAdmin);
    await store.createInvitation({
      email: "late@example.com",
      role: "member",
      tokenHash: "expired-token",
      expiresAt: "2026-07-12T00:00:00.000Z",
      invitedByUserId: admin.id,
    });

    await expect(
      store.acceptInvitation({
        tokenHash: "expired-token",
        name: "Late Member",
        passwordHash: "hash:late",
        acceptedAt: "2026-07-13T00:00:00.000Z",
      }),
    ).rejects.toThrow("Invitation has expired");
  });

  test("protects the last admin from demotion and removal", async () => {
    const store = createMemoryStore();
    const admin = await store.ensureDefaultAdmin(defaultAdmin);

    await expect(store.updateMemberRole(admin.id, "member")).rejects.toThrow("last admin");
    await expect(store.removeMember(admin.id)).rejects.toThrow("last admin");
  });

  test("revokes every session when a member is removed", async () => {
    const store = createMemoryStore();
    const admin = await store.ensureDefaultAdmin(defaultAdmin);
    const invitation = await store.createInvitation({
      email: "member@example.com",
      role: "member",
      tokenHash: "member-token",
      expiresAt: "2026-07-20T00:00:00.000Z",
      invitedByUserId: admin.id,
    });
    expect(invitation.status).toBe("pending");
    const member = await store.acceptInvitation({
      tokenHash: "member-token",
      name: "Member",
      passwordHash: "hash:member",
      acceptedAt: "2026-07-13T00:00:00.000Z",
    });
    await store.createAuthSession({
      userId: member.userId,
      tokenHash: "session-token",
      expiresAt: "2026-08-13T00:00:00.000Z",
    });

    await store.removeMember(member.userId);

    await expect(store.getAuthSession("session-token", "2026-07-13T00:00:00.000Z")).resolves.toBeNull();
  });
});
