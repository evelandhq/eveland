import { describe, expect, test } from "vitest";
import type { AgentAuthMethodDescriptor } from "@eveland/core/agent-auth";
import { serializeAgentAuthConfig } from "../lib/agent-auth-form.js";

describe("Agent Auth descriptor form", () => {
  test("serializes field values by descriptor metadata without branching on the auth method", () => {
    const descriptor: AgentAuthMethodDescriptor = {
      method: "future-interactive-method",
      label: "Future method",
      description: "A registry-provided method.",
      credentialScope: "principal",
      interactive: true,
      fields: [
        { key: "issuer", label: "Issuer", input: "text", required: true, secret: false, valueType: "string" },
        { key: "scopes", label: "Scopes", input: "text", required: true, secret: false, valueType: "string-list" },
        { key: "clientSecret", label: "Secret", input: "password", required: false, secret: true, valueType: "string" },
      ],
    };

    expect(serializeAgentAuthConfig(descriptor, {
      issuer: "https://idp.example",
      scopes: "openid, offline_access profile",
      clientSecret: "",
    })).toEqual({
      issuer: "https://idp.example",
      scopes: ["openid", "offline_access", "profile"],
    });
  });
});
