import { describe, expect, test } from "vitest";
import {
  claimPendingPlaygroundTurn,
  handleRouteAuthError,
  interactionFromClientError,
} from "./playground-route-auth.js";

describe("Playground OIDC route auth", () => {
  test("recognizes only Eveland redirect interactions", () => {
    expect(interactionFromClientError({
      status: 401,
      body: JSON.stringify({
        code: "interaction_required",
        interaction: { type: "redirect", url: "/api/eveland/agent-connections/acon_1/auth/interactions/oidc/start" },
      }),
    })).toEqual({
      type: "redirect",
      url: "/api/eveland/agent-connections/acon_1/auth/interactions/oidc/start",
    });
    expect(interactionFromClientError({
      status: 401,
      body: JSON.stringify({ code: "interaction_required", interaction: { type: "redirect", url: "https://attacker.example" } }),
    })).toBeNull();
  });

  test("stores a pending first turn before redirect and claims it exactly once", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const redirects: string[] = [];
    const handled = handleRouteAuthError({
      error: {
        status: 401,
        body: JSON.stringify({
          code: "interaction_required",
          interaction: { type: "redirect", url: "/api/eveland/agent-connections/acon_1/auth/interactions/oidc/start" },
        }),
      },
      message: "hello",
      projectId: "proj_1",
      redirect: (url) => redirects.push(url),
      storage,
    });

    expect(handled).toBe(true);
    expect(redirects).toHaveLength(1);
    expect(claimPendingPlaygroundTurn(storage, "proj_1")).toBe("hello");
    expect(claimPendingPlaygroundTurn(storage, "proj_1")).toBeNull();
  });
});
