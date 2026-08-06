import { createTestStore } from "@evelandhq/db/vitest";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createIdentityRouteServices } from "./app-identity-routes.js";
import type { ApiApp } from "./app-types.js";

describe("Identity local development configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("allows the local EveChats origin without requiring a new .env entry", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("EVELAND_IDENTITY_ALLOWED_ORIGINS", "");

    const services = createIdentityRouteServices({
      app: {} as ApiApp,
      store: createTestStore(),
      options: {},
      appSecretKey: "identity-api-secret-key-00000000",
      webOrigin: "http://localhost:3000",
    });

    expect(services.allowedOrigins).toEqual(new Set(["http://localhost:3010"]));
  });

  test("restarts the API dev process when the shared .env changes", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts.dev).toContain("--include ../../.env");
  });
});
