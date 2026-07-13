import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";
import { createPostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.EVELAND_POSTGRES_TEST_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

describe.skipIf(!database)("Postgres team authentication", () => {
  test("persists an invited member and revokes their active session on removal", async () => {
    const store = createPostgresStore(database!);
    const admin = await store.ensureDefaultAdmin({
      email: "admin@example.com",
      name: "Admin",
      passwordHash: "argon2:admin",
    });
    const invitation = await store.createInvitation({
      email: "member@example.com",
      role: "member",
      tokenHash: "postgres-invite-token",
      expiresAt: "2026-07-20T00:00:00.000Z",
      invitedByUserId: admin.id,
    });
    const member = await store.acceptInvitation({
      tokenHash: invitation.tokenHash,
      name: "Member",
      passwordHash: "argon2:member",
      acceptedAt: "2026-07-13T00:00:00.000Z",
    });
    await store.createAuthSession({
      userId: member.userId,
      tokenHash: "postgres-session-token",
      expiresAt: "2026-08-13T00:00:00.000Z",
    });

    await expect(store.getAuthSession("postgres-session-token", "2026-07-13T00:00:00.000Z")).resolves.toMatchObject({
      email: "member@example.com",
      role: "member",
    });
    await store.removeMember(member.userId);
    await expect(store.getAuthSession("postgres-session-token", "2026-07-13T00:00:00.000Z")).resolves.toBeNull();
  });
});
