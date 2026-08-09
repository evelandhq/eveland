import { afterEach, describe, expect, test, vi } from "vitest";

const startup = vi.hoisted(() => ({
  calls: [] as string[],
  dispatcherMain: vi.fn(async () => {
    startup.calls.push("dispatcher");
  }),
  healthFetch: vi.fn(async () => {
    startup.calls.push("health");
    if (startup.calls.filter((call) => call === "health").length === 1) {
      throw new TypeError("fetch failed");
    }
    return new Response(null, { status: 200 });
  }),
}));

vi.mock("@evelandhq/workflow-world/dispatcher", () => ({ main: startup.dispatcherMain }));
vi.mock("./observability.js", () => ({
  platformObservability: {
    emitLog() {},
    async shutdown() {},
  },
}));

describe("workflow dispatcher startup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.WORKFLOW_DISPATCHER_ACTIVATION_API_URL;
  });

  test("waits for a healthy control API before starting the dispatcher", async () => {
    process.env.WORKFLOW_DISPATCHER_ACTIVATION_API_URL = "http://control.test";
    vi.stubGlobal("fetch", startup.healthFetch);

    await import("./main.js");

    expect(startup.healthFetch).toHaveBeenCalledTimes(2);
    expect(startup.healthFetch).toHaveBeenLastCalledWith(
      "http://control.test/health",
      expect.objectContaining({ method: "GET" }),
    );
    expect(startup.calls).toEqual(["health", "health", "dispatcher"]);
  });
});
