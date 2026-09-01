import { describe, expect, test } from "vitest";
import { isRequestAllowedForScopes } from "./cli-auth.js";

const DEPLOY = ["deploy"];
const OBSERVE = ["observe"];
const BOTH = ["deploy", "observe"];

describe("isRequestAllowedForScopes", () => {
  test("any valid token reads its own identity, nothing else", () => {
    expect(isRequestAllowedForScopes("GET", "/api/members/me", [])).toBe(true);
    expect(isRequestAllowedForScopes("GET", "/api/members", BOTH)).toBe(false);
    expect(isRequestAllowedForScopes("POST", "/api/members/me", BOTH)).toBe(false);
    expect(isRequestAllowedForScopes("GET", "/api/members/me/extra", BOTH)).toBe(false);
  });

  test("observe reads the delivery surface", () => {
    expect(isRequestAllowedForScopes("GET", "/api/projects", OBSERVE)).toBe(true);
    expect(isRequestAllowedForScopes("GET", "/api/projects/name-availability", OBSERVE)).toBe(true);
    expect(isRequestAllowedForScopes("GET", "/api/projects/proj_1", OBSERVE)).toBe(true);
    expect(isRequestAllowedForScopes("GET", "/api/projects/proj_1/logs", OBSERVE)).toBe(true);
    expect(isRequestAllowedForScopes("GET", "/api/projects/proj_1/deployments", OBSERVE)).toBe(
      true,
    );
    expect(isRequestAllowedForScopes("GET", "/api/projects/proj_1/schedule-runs", OBSERVE)).toBe(
      true,
    );
  });

  test("observe never reaches secrets, the playground, or agent-auth", () => {
    expect(isRequestAllowedForScopes("GET", "/api/projects/proj_1/secrets", OBSERVE)).toBe(false);
    expect(
      isRequestAllowedForScopes("GET", "/api/projects/proj_1/playground/connection", OBSERVE),
    ).toBe(false);
    expect(
      isRequestAllowedForScopes(
        "GET",
        "/api/projects/proj_1/agent-auth/secret-references",
        OBSERVE,
      ),
    ).toBe(false);
    expect(isRequestAllowedForScopes("POST", "/api/projects", OBSERVE)).toBe(false);
  });

  test("deploy delivers and manages project env", () => {
    expect(isRequestAllowedForScopes("POST", "/api/projects", DEPLOY)).toBe(true);
    expect(isRequestAllowedForScopes("POST", "/api/source-preflights", DEPLOY)).toBe(true);
    expect(isRequestAllowedForScopes("POST", "/api/projects/proj_1/sync-source", DEPLOY)).toBe(
      true,
    );
    expect(isRequestAllowedForScopes("POST", "/api/projects/proj_1/build-deploy", DEPLOY)).toBe(
      true,
    );
    expect(
      isRequestAllowedForScopes("POST", "/api/projects/proj_1/deployments/dep_1/promote", DEPLOY),
    ).toBe(true);
    expect(isRequestAllowedForScopes("GET", "/api/projects/proj_1/secrets", DEPLOY)).toBe(true);
    expect(isRequestAllowedForScopes("POST", "/api/projects/proj_1/secrets", DEPLOY)).toBe(true);
    expect(
      isRequestAllowedForScopes("DELETE", "/api/projects/proj_1/secrets/secret_1", DEPLOY),
    ).toBe(true);
  });

  test("deploy does not read the observation surface or reach elsewhere", () => {
    expect(isRequestAllowedForScopes("GET", "/api/projects", DEPLOY)).toBe(false);
    expect(isRequestAllowedForScopes("DELETE", "/api/projects/proj_1", BOTH)).toBe(false);
    expect(isRequestAllowedForScopes("PATCH", "/api/projects/proj_1", BOTH)).toBe(false);
    expect(
      isRequestAllowedForScopes("POST", "/api/projects/proj_1/deployments/dep_1/drain", BOTH),
    ).toBe(false);
    expect(isRequestAllowedForScopes("GET", "/api/system/configuration", BOTH)).toBe(false);
    expect(isRequestAllowedForScopes("GET", "/api/usage", BOTH)).toBe(false);
  });

  test("unknown scopes grant nothing", () => {
    expect(isRequestAllowedForScopes("GET", "/api/projects", ["admin"])).toBe(false);
    expect(isRequestAllowedForScopes("POST", "/api/projects", ["root"])).toBe(false);
  });
});
