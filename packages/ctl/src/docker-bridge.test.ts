import { describe, expect, test } from "vitest";
import { DOCKER_BRIDGE_GATEWAY_ARGV, detectDockerBridgeHost } from "./docker-bridge.ts";
import type { ExecCommand } from "./io.ts";

function execReturning(result: { code: number | null; output: string }): {
  execCommand: ExecCommand;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    execCommand: async (argv) => {
      calls.push(argv);
      return result;
    },
  };
}

describe("detectDockerBridgeHost", () => {
  test("reads the default bridge's gateway from Docker itself", async () => {
    const exec = execReturning({ code: 0, output: "172.17.0.1\n" });

    await expect(
      detectDockerBridgeHost({ execCommand: exec.execCommand, cwd: "/repo" }),
    ).resolves.toBe("172.17.0.1");
    expect(exec.calls).toEqual([DOCKER_BRIDGE_GATEWAY_ARGV]);
  });

  test("returns null when Docker is unreachable", async () => {
    const exec = execReturning({ code: 1, output: "Cannot connect to the Docker daemon" });

    await expect(
      detectDockerBridgeHost({ execCommand: exec.execCommand, cwd: "/repo" }),
    ).resolves.toBeNull();
  });

  test.each([
    ["", "an empty format result"],
    ["<no value>", "a daemon that reports no IPAM config"],
    ["0.0.0.0", "a wildcard"],
    ["8.8.8.8", "a routable address"],
    ["172.17.0.1\n172.18.0.1", "more than one address"],
  ])("refuses %s (%s)", async (output) => {
    // Whatever this returns is written into a bind host: only a single
    // private IPv4 may ever come back out.
    const exec = execReturning({ code: 0, output });

    await expect(
      detectDockerBridgeHost({ execCommand: exec.execCommand, cwd: "/repo" }),
    ).resolves.toBeNull();
  });
});
