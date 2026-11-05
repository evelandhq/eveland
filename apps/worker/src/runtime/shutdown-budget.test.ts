import { describe, expect, test } from "vitest";

import {
  DEPLOYMENT_STOP_TIMEOUT_SECONDS,
  EVE_START_FORCED_KILL_SECONDS,
  EVE_START_LONGEST_FORCED_KILL_SECONDS,
  resolveDeploymentShutdownTimeoutSeconds,
} from "./shutdown-budget.js";

describe("resolveDeploymentShutdownTimeoutSeconds", () => {
  test("defaults to a budget the inner layers can actually reach", () => {
    expect(resolveDeploymentShutdownTimeoutSeconds({})).toBeLessThan(EVE_START_FORCED_KILL_SECONDS);
    expect(resolveDeploymentShutdownTimeoutSeconds({})).toBeGreaterThan(0);
    // An unset variable and an empty one are the same "operator said nothing".
    expect(resolveDeploymentShutdownTimeoutSeconds({})).toBe(
      resolveDeploymentShutdownTimeoutSeconds({ EVELAND_DEPLOYMENT_SHUTDOWN_TIMEOUT_SECONDS: "" }),
    );
  });

  test("takes the operator's budget", () => {
    expect(
      resolveDeploymentShutdownTimeoutSeconds({
        EVELAND_DEPLOYMENT_SHUTDOWN_TIMEOUT_SECONDS: "8",
      }),
    ).toBe(8);
  });

  test("rejects a budget `eve start` would SIGKILL through", () => {
    expect(() =>
      resolveDeploymentShutdownTimeoutSeconds({
        EVELAND_DEPLOYMENT_SHUTDOWN_TIMEOUT_SECONDS: String(EVE_START_FORCED_KILL_SECONDS),
      }),
    ).toThrow(/must be below 20/);
  });

  test.each(["0", "-1", "1.5", "later"])("rejects %s", (value) => {
    expect(() =>
      resolveDeploymentShutdownTimeoutSeconds({
        EVELAND_DEPLOYMENT_SHUTDOWN_TIMEOUT_SECONDS: value,
      }),
    ).toThrow(/positive safe integer/);
  });

  test("the unit's stop timeout outlasts every inner layer of every release in the window", () => {
    // Otherwise systemd, not the drain, decides when a Deployment dies. eve
    // 1.0.0-rc.3 raised `eve start`'s forced kill from 20 to 25 seconds, and
    // the window still holds releases on both.
    expect(EVE_START_LONGEST_FORCED_KILL_SECONDS).toBe(25);
    expect(EVE_START_FORCED_KILL_SECONDS).toBe(20);
    expect(DEPLOYMENT_STOP_TIMEOUT_SECONDS).toBeGreaterThan(EVE_START_LONGEST_FORCED_KILL_SECONDS);
  });
});
