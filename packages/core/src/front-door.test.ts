import { describe, expect, test } from "vitest";
import { classifyFrontDoorPath } from "./front-door.js";

describe("front-door path classification", () => {
  test("issuer documents go to the API verbatim", () => {
    expect(classifyFrontDoorPath("/.well-known/jwks.json")).toEqual({
      target: "api",
      upstreamPath: "/.well-known/jwks.json",
    });
    expect(classifyFrontDoorPath("/.well-known/openid-configuration")).toEqual({
      target: "api",
      upstreamPath: "/.well-known/openid-configuration",
    });
  });

  test("the /api namespace goes to the API verbatim", () => {
    for (const path of [
      "/api",
      "/api/auth/sign-in/email",
      "/api/identity/login",
      "/api/identity/oidc/callback",
      "/api/agent-catalog",
      "/api/projects/proj_1/build-deploy",
      "/api/system/identity/providers",
      "/api/members/me",
    ]) {
      expect(classifyFrontDoorPath(path)).toEqual({ target: "api", upstreamPath: path });
    }
  });

  test("the machine plane is out of reach by construction", () => {
    // Not an allowlist decision (#73's class): the machine plane is
    // registered at root /internal, which classifies to the Dashboard here
    // and is answered by the Gateway's own service-token gate before path
    // routing anyway. Under /api it would forward verbatim to a path the API
    // never registers — the api-route-namespaces architecture test pins that.
    expect(classifyFrontDoorPath("/internal/scheduler/dispatch").target).toBe("web");
    expect(classifyFrontDoorPath("/api/internal/scheduler/dispatch")).toEqual({
      target: "api",
      upstreamPath: "/api/internal/scheduler/dispatch",
    });
  });

  test("everything else is the Dashboard's", () => {
    for (const path of ["/", "/login", "/projects/proj_1", "/_next/static/x.js", "/apix"]) {
      expect(classifyFrontDoorPath(path).target).toBe("web");
    }
  });
});
