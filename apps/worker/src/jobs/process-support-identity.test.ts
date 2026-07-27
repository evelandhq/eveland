import { createTestStore } from "@eveland/db/vitest";
import { afterEach, describe, expect, test, vi } from "vitest";

import { composeDeploymentEnv } from "./process-support.js";

describe("composeDeploymentEnv Identity configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("injects local Identity defaults into development deployments", async () => {
    vi.stubEnv("EVELAND_IDENTITY_ISSUER", "");
    vi.stubEnv("EVELAND_IDENTITY_JWKS_URL", "");
    const store = createTestStore();

    const result = await composeDeploymentEnv(
      store,
      "proj_local",
      "dep_local",
      {
        nodeEnv: "development",
        appSecretKey: "eveland-test-secret-key-00000000",
      },
    );

    expect(result.env).toMatchObject({
      EVELAND_PROJECT_ID: "proj_local",
      EVELAND_IDENTITY_ISSUER: "http://localhost:4000",
      EVELAND_IDENTITY_JWKS_URL:
        "http://host.docker.internal:4000/.well-known/jwks.json",
    });
  });
});
