import { describe, expect, test } from "vitest";
import { getAgentUrlDisplay } from "./agent-url";

describe("agent url display", () => {
  test("uses the actual configured host and port from project.agentUrl", () => {
    expect(getAgentUrlDisplay({ slug: "demo", agentUrl: "https://demo.agents.example.com:8443/path" })).toEqual({
      configured: true,
      href: "https://demo.agents.example.com:8443/path",
      hostLabel: ".agents.example.com:8443",
      fullLabel: "https://demo.agents.example.com:8443/path",
    });
  });

  test("does not invent a domain when agentUrl is absent", () => {
    expect(getAgentUrlDisplay({ slug: "demo", agentUrl: null })).toEqual({
      configured: false,
      hostLabel: "Agent URL not configured",
      fullLabel: "Set EVELAND_AGENT_DOMAIN on the API to publish agent links.",
    });
  });

  test("falls back to the exact URL when it does not match the slug host pattern", () => {
    expect(getAgentUrlDisplay({ slug: "demo", agentUrl: "https://custom.example.com/agent" })).toMatchObject({
      configured: true,
      hostLabel: "custom.example.com",
      fullLabel: "https://custom.example.com/agent",
    });
  });
});
