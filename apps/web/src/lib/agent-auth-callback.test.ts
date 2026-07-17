import { describe, expect, test } from "vitest";
import { agentAuthCallbackSearch, safeAgentAuthReturnPath } from "./agent-auth-callback.js";

describe("Agent Auth callback", () => {
  test("keeps only a state-bearing query and a local return path", () => {
    expect(agentAuthCallbackSearch("?code=code&state=state")).toBe("?code=code&state=state");
    expect(agentAuthCallbackSearch("?code=code")).toBeNull();
    expect(safeAgentAuthReturnPath("/projects/proj_1/playground")).toBe("/projects/proj_1/playground");
    expect(safeAgentAuthReturnPath("//attacker.example")).toBe("/projects");
  });
});
