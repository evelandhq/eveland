import { describe, expect, test } from "vitest";
import { resolveAdminConfig, resolveBetterAuthConfig } from "./auth-config.js";

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

describe("Better Auth configuration", () => {
  test("requires an independent high-entropy Better Auth secret", () => {
    expect(() => resolveBetterAuthConfig({})).toThrow("BETTER_AUTH_SECRET");
    expect(() => resolveBetterAuthConfig({ BETTER_AUTH_SECRET: "too-short" })).toThrow("at least 32 characters");
  });

  test("resolves the API base URL and trusted web origin", () => {
    expect(resolveBetterAuthConfig({
      BETTER_AUTH_SECRET: "a-better-auth-secret-with-32-characters",
      BETTER_AUTH_URL: "https://api.example.com",
      WEB_ORIGIN: "https://app.example.com",
      EVELAND_COOKIE_DOMAIN: ".example.com",
    })).toEqual({
      secret: "a-better-auth-secret-with-32-characters",
      baseURL: "https://api.example.com",
      webOrigin: "https://app.example.com",
      cookieDomain: ".example.com",
    });
  });
});
