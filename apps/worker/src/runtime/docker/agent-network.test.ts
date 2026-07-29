import { execa } from "execa";
import { describe, expect, test, vi } from "vitest";
import {
  createAgentTelemetryNetworkReconciler,
  resolveAgentTelemetryNetworkName,
} from "./agent-network.js";

vi.mock("execa", () => ({
  execa: vi.fn(async () => ({ all: "" })),
}));

describe("Agent telemetry network reconciliation", () => {
  test("reattaches managed networks only when the Collector identity changes", async () => {
    vi.mocked(execa).mockClear();
    const processA = "eveland-proj_a-dep_a";
    const processB = "eveland-proj_b-dep_b";
    const networkA = resolveAgentTelemetryNetworkName(processA);
    const networkB = resolveAgentTelemetryNetworkName(processB);
    vi.mocked(execa)
      .mockResolvedValueOnce({
        failed: false,
        stdout: "collector-id-1\n",
      } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: `${networkA}\t${processA}\n${networkB}\t${processB}\n`,
      } as never)
      .mockResolvedValueOnce({ failed: false, all: "" } as never)
      .mockResolvedValueOnce({ failed: false, all: "" } as never)
      .mockResolvedValueOnce({
        failed: true,
        all: `Error: No such container: ${processB}`,
      } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: "collector-id-1\n",
      } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: "collector-id-2\n",
      } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: `${networkA}\t${processA}\n`,
      } as never)
      .mockResolvedValueOnce({ failed: false, all: "" } as never)
      .mockResolvedValueOnce({ failed: false, all: "" } as never);

    const reconcile = createAgentTelemetryNetworkReconciler(
      "custom-otel-collector",
    );

    await reconcile();
    await reconcile();
    await reconcile();

    expect(vi.mocked(execa).mock.calls).toEqual([
      [
        "docker",
        ["inspect", "--format", "{{.Id}}", "custom-otel-collector"],
        { all: true, reject: false },
      ],
      [
        "docker",
        [
          "network",
          "ls",
          "--filter",
          "label=com.eveland.managed=agent-telemetry",
          "--format",
          '{{.Name}}\t{{.Label "com.eveland.process"}}',
        ],
        { all: true, reject: false },
      ],
      [
        "docker",
        ["inspect", "--type", "container", processA],
        { all: true, reject: false },
      ],
      [
        "docker",
        [
          "network",
          "connect",
          "--alias",
          "eveland-otel-collector",
          networkA,
          "custom-otel-collector",
        ],
        { all: true, reject: false },
      ],
      [
        "docker",
        ["inspect", "--type", "container", processB],
        { all: true, reject: false },
      ],
      [
        "docker",
        ["inspect", "--format", "{{.Id}}", "custom-otel-collector"],
        { all: true, reject: false },
      ],
      [
        "docker",
        ["inspect", "--format", "{{.Id}}", "custom-otel-collector"],
        { all: true, reject: false },
      ],
      [
        "docker",
        [
          "network",
          "ls",
          "--filter",
          "label=com.eveland.managed=agent-telemetry",
          "--format",
          '{{.Name}}\t{{.Label "com.eveland.process"}}',
        ],
        { all: true, reject: false },
      ],
      [
        "docker",
        ["inspect", "--type", "container", processA],
        { all: true, reject: false },
      ],
      [
        "docker",
        [
          "network",
          "connect",
          "--alias",
          "eveland-otel-collector",
          networkA,
          "custom-otel-collector",
        ],
        { all: true, reject: false },
      ],
    ]);
  });

  test("silently retries after the Collector container is absent", async () => {
    vi.mocked(execa).mockClear();
    vi.mocked(execa)
      .mockResolvedValueOnce({
        failed: true,
        all: "Error: No such object: eveland-otel-collector",
      } as never)
      .mockResolvedValueOnce({
        failed: false,
        stdout: "collector-id-restored\n",
      } as never)
      .mockResolvedValueOnce({ failed: false, stdout: "" } as never);
    const reconcile = createAgentTelemetryNetworkReconciler();

    await expect(reconcile()).resolves.toBeUndefined();
    await expect(reconcile()).resolves.toBeUndefined();

    expect(vi.mocked(execa).mock.calls).toHaveLength(3);
  });
});
