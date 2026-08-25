import { describe, expect, test } from "vitest";
import {
  claimPendingPlaygroundTurn,
  handleRouteAuthError,
  interactionFromClientError,
  peekPendingPlaygroundTurn,
} from "./playground-route-auth.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

const interactionError = {
  status: 401,
  body: JSON.stringify({
    code: "interaction_required",
    interaction: {
      type: "redirect",
      url: "/api/eveland/agent-connections/acon_1/auth/interactions/oidc/start",
    },
  }),
};

describe("Playground OIDC route auth", () => {
  test("recognizes only Eveland redirect interactions", () => {
    expect(
      interactionFromClientError({
        status: 401,
        body: JSON.stringify({
          code: "interaction_required",
          interaction: {
            type: "redirect",
            url: "/api/eveland/agent-connections/acon_1/auth/interactions/oidc/start",
          },
        }),
      }),
    ).toEqual({
      type: "redirect",
      url: "/api/eveland/agent-connections/acon_1/auth/interactions/oidc/start",
    });
    expect(
      interactionFromClientError({
        status: 401,
        body: JSON.stringify({
          code: "interaction_required",
          interaction: { type: "redirect", url: "https://attacker.example" },
        }),
      }),
    ).toBeNull();
  });

  test("stores a pending first turn before redirect and claims it exactly once", () => {
    const storage = memoryStorage();
    const redirects: string[] = [];
    const handled = handleRouteAuthError({
      error: interactionError,
      message: "hello",
      session: undefined,
      projectId: "proj_1",
      redirect: (url) => redirects.push(url),
      storage,
    });

    expect(handled).toBe(true);
    expect(redirects).toHaveLength(1);
    expect(claimPendingPlaygroundTurn(storage, "proj_1")).toEqual({ message: "hello" });
    expect(claimPendingPlaygroundTurn(storage, "proj_1")).toBeNull();
  });

  test("carries the session cursor across the redirect so the conversation can resume", () => {
    const storage = memoryStorage();
    handleRouteAuthError({
      error: interactionError,
      message: "follow-up",
      session: { sessionId: "sess_1", streamIndex: 7 },
      projectId: "proj_1",
      redirect: () => undefined,
      storage,
    });

    const expected = {
      message: "follow-up",
      session: { sessionId: "sess_1", streamIndex: 7 },
    };
    // Peeking is non-destructive (it runs during render); only the claim
    // consumes the stash.
    expect(peekPendingPlaygroundTurn(storage, "proj_1")).toEqual(expected);
    expect(peekPendingPlaygroundTurn(storage, "proj_1")).toEqual(expected);
    expect(claimPendingPlaygroundTurn(storage, "proj_1")).toEqual(expected);
    expect(peekPendingPlaygroundTurn(storage, "proj_1")).toBeNull();
  });

  test("drops a malformed session cursor but keeps the message", () => {
    const storage = memoryStorage();
    storage.setItem(
      "eveland:playground:pending-route-auth:proj_1",
      JSON.stringify({ version: 1, message: "hello", session: { sessionId: 42 } }),
    );

    expect(claimPendingPlaygroundTurn(storage, "proj_1")).toEqual({ message: "hello" });
  });
});
