import { describe, expect, test } from "vitest";
import { createRuntimeAdapterFromEnv } from "./select.js";

describe("createRuntimeAdapterFromEnv", () => {
  test("defaults to the docker adapter", () => {
    expect(createRuntimeAdapterFromEnv({}).name).toBe("docker");
  });

  test("selects the systemd adapter when EVELAND_RUNTIME=systemd", () => {
    expect(createRuntimeAdapterFromEnv({ EVELAND_RUNTIME: "systemd" }).name).toBe("systemd");
  });

  test("rejects unknown runtime kinds", () => {
    expect(() => createRuntimeAdapterFromEnv({ EVELAND_RUNTIME: "kubernetes" })).toThrow(/Unknown EVELAND_RUNTIME/);
  });
});
