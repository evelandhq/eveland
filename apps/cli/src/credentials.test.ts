import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { FileCredentialStore, resolveToken } from "./credentials.js";

describe("CLI credentials", () => {
  test("stores device sessions outside the project with owner-only permissions", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "eveland-cli-auth-"));
    const store = new FileCredentialStore(configDir);

    await store.set("https://api.example.com", {
      token: "device-session-token",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });

    await expect(store.get("https://api.example.com")).resolves.toEqual({
      token: "device-session-token",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect((await stat(path.join(configDir, "auth.json"))).mode & 0o777).toBe(0o600);
  });

  test("uses an explicit CI token before the stored human session", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "eveland-cli-token-"));
    const store = new FileCredentialStore(configDir);
    await store.set("https://api.example.com", {
      token: "human-session",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });

    await expect(resolveToken("https://api.example.com", {
      explicitToken: "flag-token",
      env: { EVELAND_TOKEN: "env-token" },
      store,
    })).resolves.toBe("flag-token");
    await expect(resolveToken("https://api.example.com", {
      env: { EVELAND_TOKEN: "env-token" },
      store,
    })).resolves.toBe("env-token");
  });
});
