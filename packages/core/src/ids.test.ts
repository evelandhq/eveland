import { describe, expect, test } from "vitest";
import { claimRoutingKey, createId, idAlphabet } from "./ids.js";

describe("createId", () => {
  test("creates prefixed 10 character IDs using the approved alphabet", () => {
    const id = createId("proj");

    expect(id).toMatch(/^proj_[A-Za-z0-9]{10}$/);
    expect([...id.slice("proj_".length)].every((char) => idAlphabet.includes(char))).toBe(true);
  });
});

describe("claimRoutingKey", () => {
  test("retries collisions and returns only the value claimed atomically", async () => {
    const candidates = ["p-collision", "p-collision", "p-unique"];
    const attempted: string[] = [];

    const claimed = await claimRoutingKey(
      "p",
      async (candidate) => {
        attempted.push(candidate);
        return candidate === "p-unique" ? { routingKey: candidate } : null;
      },
      { generate: () => candidates.shift()! },
    );

    expect(attempted).toEqual(["p-collision", "p-collision", "p-unique"]);
    expect(claimed).toEqual({ routingKey: "p-unique" });
  });

  test("fails with an actionable error after the bounded retry budget", async () => {
    await expect(
      claimRoutingKey("d", async () => null, { generate: () => "d-collision", maxAttempts: 2 }),
    ).rejects.toThrow(/unique deployment routing key after 2 attempts/i);
  });
});
