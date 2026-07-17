import { describe, expect, test } from "vitest";
import { openAgentAuthConfig, sealAgentAuthConfig } from "./sealed-config.js";

const key = "0123456789abcdef0123456789abcdef";

describe("sealed Agent Auth config", () => {
  test("round-trips only with matching connection, method, and security revision AAD", () => {
    const binding = { agentConnectionId: "acon_1", method: "basic", securityRevision: 3 };
    const sealed = sealAgentAuthConfig({ username: "alice", password: "secret" }, key, binding);

    expect(sealed).not.toContain("secret");
    expect(openAgentAuthConfig(sealed, key, binding)).toEqual({ username: "alice", password: "secret" });
    expect(() => openAgentAuthConfig(sealed, key, { ...binding, securityRevision: 4 })).toThrow();
    expect(() => openAgentAuthConfig(sealed, key, { ...binding, method: "bearer" })).toThrow();
    expect(() => openAgentAuthConfig(sealed, key, { ...binding, agentConnectionId: "acon_2" })).toThrow();
  });
});
