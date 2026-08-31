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

  test("Better Auth's namespace goes to the API verbatim", () => {
    expect(classifyFrontDoorPath("/api/auth/sign-in/email")).toEqual({
      target: "api",
      upstreamPath: "/api/auth/sign-in/email",
    });
  });

  test("allowlisted browser subtrees go to the API with the prefix stripped", () => {
    expect(classifyFrontDoorPath("/api/eveland/projects/proj_1/build-deploy")).toEqual({
      target: "api",
      upstreamPath: "/projects/proj_1/build-deploy",
    });
    expect(classifyFrontDoorPath("/api/eveland/api/auth/sign-out")).toEqual({
      target: "api",
      upstreamPath: "/api/auth/sign-out",
    });
  });

  test("the browser namespace is a fail-closed allowlist", () => {
    // The machine plane must never become browser-reachable through the
    // public origin (#73) - an unlisted subtree is blocked, not forwarded.
    expect(classifyFrontDoorPath("/api/eveland/internal/scheduler/dispatch").target).toBe(
      "blocked",
    );
    expect(classifyFrontDoorPath("/api/eveland/health").target).toBe("blocked");
    expect(classifyFrontDoorPath("/api/eveland").target).toBe("blocked");
    // Prefix tricks do not widen a subtree.
    expect(classifyFrontDoorPath("/api/eveland/projectsX/abc").target).toBe("blocked");
  });

  test("everything else is the Dashboard's", () => {
    for (const path of ["/", "/login", "/projects/proj_1", "/_next/static/x.js", "/api", "/apix"]) {
      expect(classifyFrontDoorPath(path).target).toBe("web");
    }
  });
});
