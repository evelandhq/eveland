import { describe, expect, test } from "vitest";
import { CLI_VERSION_HEADER, cliVersionProblem } from "./cli-compatibility.js";

describe("CLI version compatibility", () => {
  test("names the header the eveland CLI sends", () => {
    expect(CLI_VERSION_HEADER).toBe("x-eveland-cli-version");
  });

  test("accepts any CLI that shares the platform's major version", () => {
    expect(cliVersionProblem("1.0.0", "1.0.0")).toBeNull();
    expect(cliVersionProblem("1.9.3", "1.0.0")).toBeNull();
    expect(cliVersionProblem("1.0.0", "1.12.4")).toBeNull();
    expect(cliVersionProblem("1.2.0-rc.1", "1.0.0")).toBeNull();
  });

  test("tells an older CLI which major to install", () => {
    expect(cliVersionProblem("1.4.2", "2.0.1")).toBe(
      "eveland CLI 1.4.2 is not compatible with this Eveland platform (2.0.1): the CLI must " +
        "have the platform's major version, 2. Install eveland@2 (for example `npm install " +
        "eveland@2`).",
    );
  });

  test("tells a newer CLI which major the platform serves", () => {
    expect(cliVersionProblem("3.0.0", "2.5.0")).toBe(
      "eveland CLI 3.0.0 is not compatible with this Eveland platform (2.5.0): the CLI must " +
        "have the platform's major version, 2. Install eveland@2 (for example `npm install " +
        "eveland@2`), or upgrade the platform.",
    );
  });

  test("rejects a version it cannot read", () => {
    expect(cliVersionProblem("latest", "1.0.0")).toBe(
      'This Eveland platform (1.0.0) cannot read the eveland CLI version "latest". ' +
        "Install eveland@1 (for example `npm install eveland@1`).",
    );
    expect(cliVersionProblem("", "1.0.0")).not.toBeNull();
  });
});
