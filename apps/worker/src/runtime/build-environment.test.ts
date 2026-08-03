import { describe, expect, test } from "vitest";

import { rejectedBuildVariablesLog, selectBuildVariables } from "./build-environment.js";

describe("selectBuildVariables", () => {
  test("passes ordinary Agent variables through to the build", () => {
    expect(
      selectBuildVariables({
        MODEL_NAME: "configured-model",
        OPENAI_BASE_URL: "https://x/v1",
      }),
    ).toEqual({
      variables: { MODEL_NAME: "configured-model", OPENAI_BASE_URL: "https://x/v1" },
      rejectedKeys: [],
    });
  });

  test("never lets a project entry take over a build name the platform owns", () => {
    const selected = selectBuildVariables({
      HOME: "/tmp/attacker",
      MODEL_NAME: "authored-fallback-model",
      NPM_CONFIG_CACHE: "/tmp/attacker-cache",
      PATH: "/tmp/attacker-bin",
    });

    expect(selected.variables).toEqual({ MODEL_NAME: "authored-fallback-model" });
    expect(selected.rejectedKeys).toEqual(["HOME", "NPM_CONFIG_CACHE", "PATH"]);
  });

  // NODE_ENV=production makes `npm ci` and `pnpm install --frozen-lockfile`
  // omit devDependencies, so an entry carrying it would strip the project's own
  // build toolchain out of the install `npx eve build` then runs against -- on
  // the Shared Agent Environment, for every project at once.
  test("keeps NODE_ENV out of the build so the install still gets devDependencies", () => {
    const selected = selectBuildVariables({
      MODEL_NAME: "configured-model",
      NODE_ENV: "production",
    });

    expect(selected.variables).toEqual({ MODEL_NAME: "configured-model" });
    expect(selected.rejectedKeys).toEqual(["NODE_ENV"]);
  });

  test("drops every name the platform reserves at runtime", () => {
    const selected = selectBuildVariables({
      EVELAND_PROJECT_ID: "proj_someone_elses",
      MODEL_NAME: "configured-model",
      WORKFLOW_POSTGRES_MAX_POOL_SIZE: "500",
      WORKFLOW_POSTGRES_URL: "postgres://attacker@host:5432/db",
    });

    expect(selected.variables).toEqual({ MODEL_NAME: "configured-model" });
    expect(selected.rejectedKeys).toEqual([
      "EVELAND_PROJECT_ID",
      "WORKFLOW_POSTGRES_MAX_POOL_SIZE",
      "WORKFLOW_POSTGRES_URL",
    ]);
  });

  test("treats a missing variable set as an empty one", () => {
    expect(selectBuildVariables(undefined)).toEqual({ variables: {}, rejectedKeys: [] });
  });
});

describe("rejectedBuildVariablesLog", () => {
  test("stays silent when nothing was dropped", () => {
    expect(rejectedBuildVariablesLog([])).toBeUndefined();
  });

  test("names every dropped key so the drop is not silent", () => {
    expect(rejectedBuildVariablesLog(["HOME", "PATH"])).toContain("HOME, PATH");
  });

  // A build name still reaches the deployed process; a runtime-reserved one is
  // overridden there too. Reporting both under one sentence would tell the
  // operator something false about half of them.
  test("separates a build-only drop from a name the platform owns at runtime", () => {
    const log = rejectedBuildVariablesLog(["NODE_ENV", "PATH"])!;
    const [buildLine, reservedLine] = log.split("\n");

    expect(buildLine).toContain("PATH");
    expect(buildLine).toContain("still reach the deployed process");
    expect(reservedLine).toContain("NODE_ENV");
    expect(reservedLine).not.toContain("still reach the deployed process");
  });

  test("reports only the line the dropped keys call for", () => {
    expect(rejectedBuildVariablesLog(["PATH"])).not.toContain("\n");
    expect(rejectedBuildVariablesLog(["NODE_ENV"])).not.toContain("\n");
  });
});
