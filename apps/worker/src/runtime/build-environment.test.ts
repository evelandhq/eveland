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
});
