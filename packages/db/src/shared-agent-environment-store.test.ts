import { describe, expect, test } from "vitest";
import { createTestStore } from "./vitest-store.js";

describe("shared Agent environment store", () => {
  test("persists one revisioned environment without exposing encrypted values", async () => {
    const store = createTestStore();

    const created = await store.saveSharedAgentEnvironment({
      entries: [
        { key: "OPENAI_API_KEY", kind: "secret", encryptedValue: "encrypted-key" },
        { key: "MODEL_REGION", kind: "variable", encryptedValue: "encrypted-region" },
      ],
    });
    expect(created).toMatchObject({
      revision: 1,
      entries: [
        { key: "MODEL_REGION", kind: "variable", configured: true },
        { key: "OPENAI_API_KEY", kind: "secret", configured: true },
      ],
    });
    expect(JSON.stringify(created)).not.toContain("encrypted-");

    const unchanged = await store.saveSharedAgentEnvironment({
      entries: [
        { key: "OPENAI_API_KEY", kind: "secret", encryptedValue: "encrypted-key" },
        { key: "MODEL_REGION", kind: "variable", encryptedValue: "encrypted-region" },
      ],
    });
    expect(unchanged.revision).toBe(1);

    const updated = await store.saveSharedAgentEnvironment({
      entries: [{ key: "OPENAI_API_KEY", kind: "secret", encryptedValue: "encrypted-key-v2" }],
    });
    expect(updated.revision).toBe(2);
    await expect(store.getSharedAgentEnvironmentRecord()).resolves.toMatchObject({
      revision: 2,
      entries: [{ key: "OPENAI_API_KEY", kind: "secret", encryptedValue: "encrypted-key-v2" }],
    });
  });
});
