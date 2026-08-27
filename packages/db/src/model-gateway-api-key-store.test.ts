import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

const now = new Date("2026-08-27T05:00:00.000Z");
const later = new Date("2026-08-27T06:00:00.000Z");

// The vitest template store pre-seeds this member.
const MEMBER_ID = "user_a";

describe("model gateway personal api keys", () => {
  test("a minted key resolves by hash until revoked", async () => {
    const store = createTestStore();
    const user = { id: MEMBER_ID };
    const record = await store.mintModelGatewayApiKey(
      { userId: user.id, name: "local eve dev", tokenHash: "a".repeat(64) },
      now,
    );
    expect(record).toMatchObject({ userId: user.id, name: "local eve dev", revokedAt: null });

    await expect(store.findActiveModelGatewayApiKeyByHash("a".repeat(64))).resolves.toMatchObject({
      id: record.id,
      userId: user.id,
    });

    expect(await store.revokeModelGatewayApiKey(record.id, later)).toBe(true);
    await expect(store.findActiveModelGatewayApiKeyByHash("a".repeat(64))).resolves.toBeNull();

    const listed = await store.listModelGatewayApiKeys();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.revokedAt).toBe(later.toISOString());
  });

  test("the listing never exposes the hash", async () => {
    const store = createTestStore();
    await store.mintModelGatewayApiKey(
      { userId: MEMBER_ID, name: "ci", tokenHash: "b".repeat(64) },
      now,
    );
    const listed = await store.listModelGatewayApiKeys();
    expect(JSON.stringify(listed)).not.toContain("b".repeat(64));
  });

  test("revoking an unknown key reports false", async () => {
    const store = createTestStore();
    expect(await store.revokeModelGatewayApiKey("mgak_missing", now)).toBe(false);
  });
});
