import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createConfigurationSnapshot } from "@eveland/core/config-diagnostics";
import { writeConfigurationSnapshotFile } from "@eveland/core/server/config-diagnostics";
import { collectSystemConfigurationDiagnostics } from "./config-diagnostics.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("system configuration diagnostics", () => {
  test("combines API, private Gateway, and Worker snapshots without exposing their secrets", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "eveland-api-config-"));
    tempDirectories.push(dataDir);
    const observedAt = new Date("2026-07-15T00:00:00.000Z");
    const worker = createConfigurationSnapshot("worker", { APP_SECRET_KEY: "worker-secret" }, observedAt);
    const gateway = createConfigurationSnapshot("gateway", { EVELAND_GATEWAY_AFFINITY_SECRET: "gateway-secret" }, observedAt);
    await writeConfigurationSnapshotFile(dataDir, worker);
    const fetchDiagnostics = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://gateway.internal:4080/internal/diagnostics/config");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer service-token");
      return Response.json(gateway);
    });

    const diagnostics = await collectSystemConfigurationDiagnostics(
      {
        APP_SECRET_KEY: "api-secret",
        EVELAND_DATA_DIR: dataDir,
        EVELAND_GATEWAY_INTERNAL_URL: "http://gateway.internal:4080/",
        EVELAND_GATEWAY_SERVICE_TOKEN: "service-token",
      },
      { fetch: fetchDiagnostics, observedAt },
    );

    expect(diagnostics.components.map((component) => component.component)).toEqual(["api", "gateway", "worker"]);
    expect(fetchDiagnostics).toHaveBeenCalledOnce();
    expect(JSON.stringify(diagnostics)).not.toContain("api-secret");
    expect(JSON.stringify(diagnostics)).not.toContain("worker-secret");
    expect(JSON.stringify(diagnostics)).not.toContain("gateway-secret");
  });
});
