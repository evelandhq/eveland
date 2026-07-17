import { describe, expect, test } from "vitest";
import { agentAuthCallbackSearch, safeAgentAuthReturnPath } from "./agent-auth-callback";

describe("agent auth callback page model", () => {
  test("forwards the identity provider response only when it carries a state", () => {
    expect(agentAuthCallbackSearch("?code=authorization-code&state=abc123")).toBe(
      "?code=authorization-code&state=abc123",
    );
    expect(agentAuthCallbackSearch("?error=access_denied&state=abc123")).toBe(
      "?error=access_denied&state=abc123",
    );
    expect(agentAuthCallbackSearch("?code=authorization-code")).toBeNull();
    expect(agentAuthCallbackSearch("")).toBeNull();
  });

  test("only navigates to same-origin relative return paths", () => {
    expect(safeAgentAuthReturnPath("/projects/prj_1/playground")).toBe("/projects/prj_1/playground");
    expect(safeAgentAuthReturnPath("//evil.example/phish")).toBe("/projects");
    expect(safeAgentAuthReturnPath("/\\evil.example")).toBe("/projects");
    expect(safeAgentAuthReturnPath("https://evil.example")).toBe("/projects");
    expect(safeAgentAuthReturnPath(undefined)).toBe("/projects");
  });
});
