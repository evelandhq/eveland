import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { repoRoot } from "./home.ts";
import {
  absoluteProcessDir,
  childEnvironment,
  PLATFORM_PROCESSES,
  processByKey,
} from "./processes.ts";

describe("the supervised topology", () => {
  test("covers exactly the five required platform processes (docs is dev-only)", () => {
    expect(PLATFORM_PROCESSES.map((spec) => spec.key)).toEqual([
      "gateway",
      "api",
      "web",
      "worker",
      "workflow-dispatcher",
    ]);
  });

  test("every process directory exists in the source tree", async () => {
    for (const spec of PLATFORM_PROCESSES) {
      const dir = absoluteProcessDir(repoRoot(), spec);
      await expect(access(dir), `${spec.key} at ${dir}`).resolves.toBeUndefined();
      expect(path.isAbsolute(dir)).toBe(true);
    }
  });

  test("readiness probes stay on loopback and only listener processes have one", () => {
    for (const spec of PLATFORM_PROCESSES) {
      if (spec.key === "worker" || spec.key === "workflow-dispatcher") {
        expect(spec.readinessUrl).toBeNull();
      } else {
        expect(spec.readinessUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
      }
    }
  });

  test("the api and gateway load the observability register hook, like production compose does", () => {
    for (const key of ["api", "gateway"] as const) {
      expect(processByKey(key)?.argv).toContain(
        "--import=@evelandhq/platform-observability/register",
      );
    }
  });
});

describe("childEnvironment", () => {
  test("the pinned interpreter's bin dir leads PATH so pnpm resolves from any shell or a reboot", () => {
    const merged = childEnvironment(
      { PATH: "/usr/bin:/opt/eveland/node/bin:/bin" },
      { EVELAND_NODE: "/opt/eveland/node/bin/node" },
    );
    expect(merged.PATH).toBe("/opt/eveland/node/bin:/usr/bin:/bin");
    // Without a pin the shell's PATH is left alone.
    expect(childEnvironment({ PATH: "/usr/bin" }, {}).PATH).toBe("/usr/bin");
  });

  test("the platform env file overrides the invoking shell, never the reverse", () => {
    const merged = childEnvironment(
      { PATH: "/usr/bin", NODE_ENV: "test", EXTRA: "shell" },
      { NODE_ENV: "production", DATABASE_URL: "postgres://x" },
    );
    expect(merged.PATH).toBe("/usr/bin");
    expect(merged.EXTRA).toBe("shell");
    expect(merged.NODE_ENV).toBe("production");
    expect(merged.DATABASE_URL).toBe("postgres://x");
  });
});
