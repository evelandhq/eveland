import { describe, expect, test } from "vitest";
import { classifyFrontDoorPath } from "@evelandhq/core/front-door";
import { identityBrowserCorsPaths } from "./app.js";

/**
 * Pins the API's public browser surface to the front door's routing table.
 * The #421 regression class: an endpoint registered as public on the API but
 * classified to the Dashboard by the front door works in every direct-API
 * test and fails only in the production topology. Every path the API treats
 * as browser-public must classify to the `api` target, verbatim.
 */
describe("front-door exposure of the API's public browser surface", () => {
  test("every CORS-exposed chat-client path routes to the API verbatim", () => {
    for (const path of identityBrowserCorsPaths) {
      expect(classifyFrontDoorPath(path)).toEqual({ target: "api", upstreamPath: path });
    }
  });

  test("issuer-anchored navigation endpoints route to the API verbatim", () => {
    // Browser navigations, not fetches, so they live outside the CORS set:
    // the SDK-generated challenge URL, the IdP-registered OIDC callback, and
    // the Better Auth login continuation.
    for (const path of [
      "/api/identity/login",
      "/api/identity/oidc/callback",
      "/api/identity/continue",
      "/.well-known/jwks.json",
    ]) {
      expect(classifyFrontDoorPath(path)).toEqual({ target: "api", upstreamPath: path });
    }
  });
});
