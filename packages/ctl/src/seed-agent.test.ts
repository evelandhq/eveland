import { access } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { repoRoot } from "./home.ts";
import { BUILT_IN_AGENT_NAME, cliBinPath, runSeedAgent, starterTemplateDir } from "./seed-agent.ts";

function makeRunner(exitCodes: Array<number | null> = []) {
  const calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = [];
  const queue = [...exitCodes];
  return {
    calls,
    streamCommand: async (argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
      calls.push({ argv, env: options.env });
      return queue.shift() ?? 0;
    },
  };
}

const BASE = {
  repoRootDir: "/repo",
  publicOrigin: "http://localhost:17300",
  accessToken: "tok-secret",
  parentEnv: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
  nodeBin: "/usr/bin/node",
  print: () => {},
};

describe("runSeedAgent", () => {
  test("deploys the in-tree template through the real eveland CLI with the minted token", async () => {
    const runner = makeRunner();
    await runSeedAgent({ ...BASE, envValues: {}, streamCommand: runner.streamCommand });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.argv).toEqual([
      "/usr/bin/node",
      "/repo/packages/cli/src/bin.ts",
      "deploy",
      "/repo/templates/starter-agent",
      "--origin",
      "http://localhost:17300",
      "--name",
      BUILT_IN_AGENT_NAME,
    ]);
    expect(runner.calls[0]!.env.EVELAND_TOKEN).toBe("tok-secret");
    expect(runner.calls[0]!.env.PATH).toBe("/usr/bin");
  });

  test("forwards collected model keys into the agent's project env after the deploy", async () => {
    const runner = makeRunner();
    await runSeedAgent({
      ...BASE,
      envValues: { ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-oai-y", UNRELATED: "no" },
      streamCommand: runner.streamCommand,
    });
    expect(runner.calls.map((call) => call.argv[2])).toEqual(["deploy", "env", "env"]);
    expect(runner.calls[1]!.argv).toContain("ANTHROPIC_API_KEY=sk-ant-x");
    expect(runner.calls[2]!.argv).toContain("OPENAI_API_KEY=sk-oai-y");
    for (const call of runner.calls.slice(1)) {
      expect(call.argv).toContain("--name");
      expect(call.argv).toContain(BUILT_IN_AGENT_NAME);
      expect(call.argv.join(" ")).not.toContain("UNRELATED");
    }
  });

  test("a failed deploy throws with the manual recovery command", async () => {
    const runner = makeRunner([1]);
    await expect(
      runSeedAgent({ ...BASE, envValues: {}, streamCommand: runner.streamCommand }),
    ).rejects.toThrow(/eveland deploy templates\/starter-agent/);
  });

  test("a failed env set names the key and the recovery command", async () => {
    const runner = makeRunner([0, 1]);
    await expect(
      runSeedAgent({
        ...BASE,
        envValues: { ANTHROPIC_API_KEY: "sk-ant-x" },
        streamCommand: runner.streamCommand,
      }),
    ).rejects.toThrow(/eveland env set ANTHROPIC_API_KEY=/);
  });

  test("the CLI bin and starter template actually exist where seeding points", async () => {
    const root = repoRoot();
    await expect(access(cliBinPath(root))).resolves.toBeUndefined();
    await expect(access(starterTemplateDir(root))).resolves.toBeUndefined();
  });
});
