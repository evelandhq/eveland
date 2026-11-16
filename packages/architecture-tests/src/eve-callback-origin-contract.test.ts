import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { repoRoot } from "./scan-support.js";

/**
 * The worker injects WORKFLOW_LOCAL_BASE_URL into every Deployment so the
 * callback URLs eve hands out name the project's public Agent origin instead
 * of the loopback port the process serves on. That only works while eve reads
 * the variable, which nothing but its shipped bundle states: eve is resolved
 * from `packages/agent-observer`, which installs the verified release.
 */
const require = createRequire(import.meta.url);

function eveRoot(): string {
  let directory = path.dirname(
    require.resolve("eve", { paths: [path.join(repoRoot, "packages/agent-observer")] }),
  );
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as {
        name?: string;
      };
      if (manifest.name === "eve") return directory;
    } catch {
      // keep walking
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("could not find eve's package root");
    directory = parent;
  }
}

describe("eve's public callback origin", () => {
  test("callback URLs start from WORKFLOW_LOCAL_BASE_URL before the serving address", () => {
    const source = readFileSync(
      path.join(eveRoot(), "dist/src/execution/workflow-callback-url.js"),
      "utf8",
    );
    expect(source).toMatch(/function resolveWorkflowCallbackBaseUrl\(/);
    expect(source).toContain("process.env.WORKFLOW_LOCAL_BASE_URL");
  });
});
