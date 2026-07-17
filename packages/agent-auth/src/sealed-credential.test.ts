import { describe, expect, test } from "vitest";
import { openAgentAuthCredential, sealAgentAuthCredential } from "./sealed-credential.js";

const key = "0123456789abcdef0123456789abcdef";

describe("sealed Agent credential", () => {
  test("binds ciphertext to connection, revision, method, scope, subject, and credential key", () => {
    const binding = {
      agentConnectionId: "acon_1",
      securityRevision: 3,
      authMethod: "future-interactive",
      credentialScope: "principal" as const,
      scopeSubject: "member-a",
      credentialKey: "default",
    };
    const sealed = sealAgentAuthCredential({ accessToken: "secret-token" }, key, binding);

    expect(sealed).not.toContain("secret-token");
    expect(openAgentAuthCredential(sealed, key, binding)).toEqual({ accessToken: "secret-token" });
    for (const changed of [
      { ...binding, agentConnectionId: "acon_2" },
      { ...binding, securityRevision: 4 },
      { ...binding, authMethod: "other" },
      { ...binding, credentialScope: "connection" as const, scopeSubject: "" },
      { ...binding, scopeSubject: "member-b" },
      { ...binding, credentialKey: "other" },
    ]) {
      expect(() => openAgentAuthCredential(sealed, key, changed)).toThrow();
    }
  });
});
