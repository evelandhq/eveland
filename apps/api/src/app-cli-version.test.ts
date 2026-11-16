import { createBuildInfo } from "@evelandhq/core/build-info";
import { createTestStore } from "@evelandhq/db/vitest";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.js";

const buildInfo = {
  ...createBuildInfo("api", { revision: "test", channel: "dev" }),
  version: "2.3.0",
};

describe("CLI version handshake", () => {
  test("serves a CLI with the platform's major version", async () => {
    const store = createTestStore();
    const response = await createApp(store, { buildInfo }).request("/api/projects", {
      headers: { "x-eveland-cli-version": "2.0.1" },
    });

    expect(response.status).toBe(200);
  });

  test("answers an older CLI with the major to install and does not run the request", async () => {
    const store = createTestStore();
    const response = await createApp(store, { buildInfo }).request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-eveland-cli-version": "1.9.0" },
      body: JSON.stringify({ name: "not-created", importKind: "zip" }),
    });

    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toEqual({
      error: "cli_version_unsupported",
      error_description:
        "eveland CLI 1.9.0 is not compatible with this Eveland platform (2.3.0): the CLI must " +
        "have the platform's major version, 2. Install eveland@2 (for example `npm install " +
        "eveland@2`).",
    });
    await expect(store.listProjects()).resolves.toEqual([]);
  });

  test("answers a newer CLI, including on the unauthenticated device flow", async () => {
    const store = createTestStore();
    const response = await createApp(store, { buildInfo }).request("/api/auth/device/code", {
      method: "POST",
      headers: { "x-eveland-cli-version": "3.0.0" },
    });

    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toMatchObject({
      error: "cli_version_unsupported",
      error_description: expect.stringContaining("or upgrade the platform."),
    });
  });

  test("leaves requests without a CLI version, such as the Dashboard's, alone", async () => {
    const store = createTestStore();
    const response = await createApp(store, { buildInfo }).request("/api/projects");

    expect(response.status).toBe(200);
  });
});
