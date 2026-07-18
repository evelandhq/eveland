import type { AgentAuthMethodDescriptor } from "@eveland/core/agent-auth";
import { describe, expect, test } from "vitest";
import { agentAuthValuesFromConfig, serializeAgentAuthConfig } from "./agent-auth-form.js";

const descriptor: AgentAuthMethodDescriptor = {
  method: "example",
  label: "Example",
  description: "Example provider",
  credentialScope: "connection",
  interactive: false,
  fields: [
    { key: "name", label: "Name", input: "text", required: true, secret: false, valueType: "string" },
    { key: "token", label: "Token", input: "password", required: true, secret: true, valueType: "string" },
    { key: "scopes", label: "Scopes", input: "text", required: false, secret: false, valueType: "string-list" },
    { key: "headers", label: "Headers", input: "textarea", required: false, secret: true, valueType: "json-record" },
    { key: "mode", label: "Mode", input: "select", required: true, secret: false, valueType: "string", defaultValue: "safe" },
  ],
};

describe("Agent Auth form", () => {
  test("serializes typed values and omits blank secrets so the server preserves them", () => {
    expect(serializeAgentAuthConfig(descriptor, {
      name: "Agent",
      token: "",
      scopes: "openid, profile",
      headers: "{\"x-api-key\":\"secret\"}",
    })).toEqual({
      name: "Agent",
      scopes: ["openid", "profile"],
      headers: { "x-api-key": "secret" },
      mode: "safe",
    });
  });

  test("never hydrates secret fields from redacted API config", () => {
    expect(agentAuthValuesFromConfig(descriptor, {
      name: "Agent",
      token: "must-not-render",
      scopes: ["openid", "profile"],
      headers: { "x-api-key": "must-not-render" },
    })).toEqual({ name: "Agent", scopes: "openid profile", mode: "safe" });
  });

  test("rejects missing required public fields and malformed JSON records", () => {
    expect(() => serializeAgentAuthConfig(descriptor, { name: "", token: "" })).toThrow(/Name is required/);
    expect(() => serializeAgentAuthConfig(descriptor, { name: "Agent", headers: "[]" })).toThrow(/JSON object/);
  });

  test("serializes a selected secret reference instead of a copied value", () => {
    const referencedDescriptor: AgentAuthMethodDescriptor = {
      ...descriptor,
      fields: descriptor.fields.map((field) => field.key === "token"
        ? { ...field, secretReferenceKey: "tokenRef" }
        : field),
    };

    expect(serializeAgentAuthConfig(referencedDescriptor, { name: "Agent", token: "" }, {
      tokenRef: { kind: "project-secret", key: "ACCESS_TOKEN" },
    })).toEqual({
      name: "Agent",
      tokenRef: { kind: "project-secret", key: "ACCESS_TOKEN" },
      mode: "safe",
    });
  });
});
