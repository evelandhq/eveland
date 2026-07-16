import { describe, expect, test } from "vitest";
import { ClientError } from "eve/client";
import {
  claimPendingPlaygroundTurn,
  handleRouteAuthError,
  interactionFromClientError,
} from "./playground-route-auth.js";

describe("Playground Route Auth state", () => {
  test("recognizes a route auth error reported by the React binding", () => {
    const body = JSON.stringify({
      code: "interaction_required",
      method: "oidc",
      message: "Authorize this Agent Connection.",
      interaction: { type: "redirect", url: "/api/eveland/agent-connections/acon_1/auth/interactions/oidc/start" },
    });
    const error = Object.assign(new Error(body), {
      body,
      headers: {},
      name: "ClientError",
      status: 401,
    });

    expect(interactionFromClientError(error)).toEqual({
      type: "redirect",
      url: "/api/eveland/agent-connections/acon_1/auth/interactions/oidc/start",
    });
  });

  test("keeps an interaction-blocked turn across the callback and claims it only once", () => {
    const storage = new MemoryStorage();
    const message = "send after OIDC";
    const error = new ClientError(401, JSON.stringify({
      code: "interaction_required",
      method: "oidc",
      message: "Authorize this Agent Connection.",
      interaction: { type: "redirect", url: "/api/eveland/agent-connections/acon_1/auth/interactions/oidc/start" },
    }));
    const redirects: string[] = [];

    expect(handleRouteAuthError({
      error,
      message,
      projectId: "proj_oidc",
      redirect: (url) => redirects.push(url),
      storage,
    })).toBe(true);
    expect(redirects).toEqual([
      "/api/eveland/agent-connections/acon_1/auth/interactions/oidc/start",
    ]);
    expect(claimPendingPlaygroundTurn(storage, "proj_oidc")).toEqual(message);
    expect(claimPendingPlaygroundTurn(storage, "proj_oidc")).toBeNull();
  });
});

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
