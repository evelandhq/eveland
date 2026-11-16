import { describe, expect, test } from "vitest";
import { isRequestAllowedForScopes } from "./cli-auth.js";

const DEPLOY = ["deploy"];
const OBSERVE = ["observe"];
const BOTH = ["deploy", "observe"];

describe("isRequestAllowedForScopes", () => {
  test("any valid token reads its own identity, nothing else", () => {
    expect(isRequestAllowedForScopes("GET", "/api/members/me", [])).toBe(true);
    expect(isRequestAllowedForScopes("GET", "/api/instance", [])).toBe(true);
    expect(isRequestAllowedForScopes("POST", "/api/instance", BOTH)).toBe(false);
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
    for (const read of [
      "endpoints",
      "jobs",
      "usage",
      "eve-version",
      "schedules",
      "schedule-attention",
      "sessions",
    ]) {
      expect(isRequestAllowedForScopes("GET", `/api/projects/proj_1/${read}`, OBSERVE), read).toBe(
        true,
      );
    }
  });

  test("observe reads a single session by id", () => {
    for (const path of [
      "/api/sessions/sess_1",
      "/api/sessions/sess_1/events",
      "/api/sessions/sess_1/nodes",
      "/api/sessions/sess_1/usage",
    ]) {
      expect(isRequestAllowedForScopes("GET", path, OBSERVE), path).toBe(true);
      expect(isRequestAllowedForScopes("GET", path, DEPLOY), path).toBe(false);
    }
    expect(isRequestAllowedForScopes("GET", "/api/sessions", OBSERVE)).toBe(false);
    expect(isRequestAllowedForScopes("GET", "/api/sessions/sess_1/other", OBSERVE)).toBe(false);
    expect(isRequestAllowedForScopes("DELETE", "/api/sessions/sess_1", BOTH)).toBe(false);
  });

  // An allowlist: a project route observe does not name is out of reach,
  // including one added later.
  test("observe reaches only the project reads it names", () => {
    for (const path of [
      "/api/projects/proj_1/source/files",
      "/api/projects/proj_1/source/file",
      "/api/projects/proj_1/source/revision",
      "/api/projects/proj_1/model-gateway",
      "/api/projects/proj_1/routes",
      "/api/projects/proj_1/some-future-route",
      "/api/projects/proj_1/logs/extra",
      "/api/projects/proj_1/schedule-runs/acknowledge",
      "/api/projects/name-availability/extra",
    ]) {
      expect(isRequestAllowedForScopes("GET", path, OBSERVE), path).toBe(false);
    }
    expect(isRequestAllowedForScopes("POST", "/api/projects/proj_1/schedule-runs", OBSERVE)).toBe(
      false,
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
    expect(isRequestAllowedForScopes("GET", "/api/source-preflights/pre_abc123", DEPLOY)).toBe(
      true,
    );
    expect(isRequestAllowedForScopes("GET", "/api/source-preflights/pre_abc123", OBSERVE)).toBe(
      false,
    );
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
