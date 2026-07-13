import { describe, expect, test } from "vitest";
import { resolveAdminConfig } from "./auth-config.js";

describe("default admin configuration", () => {
  test("defaults the admin email to admin@example.com", () => {
    expect(resolveAdminConfig({ EVELAND_ADMIN_PASSWORD: "a-secure-initial-password" })).toEqual({
      email: "admin@example.com",
      name: "Admin",
      password: "a-secure-initial-password",
    });
  });

  test("requires an explicit initial password", () => {
    expect(() => resolveAdminConfig({})).toThrow("EVELAND_ADMIN_PASSWORD");
  });

  test("rejects a short initial password", () => {
    expect(() => resolveAdminConfig({ EVELAND_ADMIN_PASSWORD: "too-short" })).toThrow("at least 12 characters");
  });
});
