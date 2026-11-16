import { describe, expect, test } from "vitest";
import { unsupportedEveSpecifierMessage } from "./eve-compatibility.js";
import { inspectEveProject, unsupportedLayoutMessage } from "./source.js";

describe("inspectEveProject", () => {
  test("recognizes nested eve agent layout and summarizes authored slots", () => {
    const result = inspectEveProject([
      {
        path: "package.json",
        content: JSON.stringify({ name: "weather-agent", dependencies: { eve: "1.0.0" } }),
      },
      {
        path: "agent/agent.ts",
        content: `export default defineAgent({ model: process.env.DEFAULT_MODEL })`,
      },
      { path: "agent/instructions.md", content: "You are a weather agent." },
      {
        path: "agent/channels/eve.ts",
        content: `import { eveChannel } from "eve/channels/eve";\nexport default eveChannel({});`,
      },
      { path: "agent/tools/get_weather.ts", content: "export default defineTool({})" },
      { path: "agent/skills/report.md", content: "---\ndescription: Report\n---" },
      { path: "agent/connections/linear.ts", content: "process.env.LINEAR_API_TOKEN" },
      {
        path: "agent/subagents/researcher/agent.ts",
        content: "export default defineAgent({ description: 'Research' })",
      },
      { path: "agent/sandbox/sandbox.ts", content: "export default defineSandbox({})" },
      { path: "agent/schedules/daily.md", content: '---\ncron: "0 8 * * *"\n---\nReport.' },
      { path: ".env.example", content: "OPENAI_API_KEY=\nANTHROPIC_API_KEY=example\n" },
    ]);

    expect(result.valid).toBe(true);
    expect(result.layout).toBe("nested");
    expect(result.projectName).toBe("weather-agent");
    expect(result.eveVersion).toBe("1.0.0");
    expect(result.summary).toMatchObject({
      agents: ["agent/agent.ts"],
      instructions: ["agent/instructions.md"],
      tools: ["agent/tools/get_weather.ts"],
      skills: ["agent/skills/report.md"],
      subagents: ["agent/subagents/researcher"],
      connections: ["agent/connections/linear.ts"],
      schedules: ["agent/schedules/daily.md"],
      sandbox: ["agent/sandbox/sandbox.ts"],
    });
    expect(result.envVars).toEqual([
      "ANTHROPIC_API_KEY",
      "DEFAULT_MODEL",
      "LINEAR_API_TOKEN",
      "OPENAI_API_KEY",
    ]);
  });

  test("uses Eve's authored skill extensions in the source summary", () => {
    const result = inspectEveProject([
      { path: "package.json", content: JSON.stringify({ dependencies: { eve: "1.0.0" } }) },
      { path: "agent/instructions.md", content: "You are an agent." },
      ...["md", "ts", "cts", "mts", "js", "cjs", "mjs"].map((extension) => ({
        path: `agent/skills/research.${extension}`,
        content: "skill",
      })),
      { path: "agent/skills/not-a-skill.mdx", content: "unsupported" },
      { path: "agent/skills/not-a-skill.tsx", content: "unsupported" },
      { path: "agent/skills/not-a-skill.d.ts", content: "unsupported" },
      { path: "agent/skills/packaged/SKILL.md", content: "packaged skill" },
      { path: "agent/skills/packaged/references/checklist.md", content: "supporting resource" },
    ]);

    expect(result.summary.skills).toEqual([
      "agent/skills/packaged/SKILL.md",
      "agent/skills/research.cjs",
      "agent/skills/research.cts",
      "agent/skills/research.js",
      "agent/skills/research.md",
      "agent/skills/research.mjs",
      "agent/skills/research.mts",
      "agent/skills/research.ts",
    ]);
  });

  test("rejects a repository without agent instructions", () => {
    const result = inspectEveProject([{ path: "agent/tools/get_weather.ts", content: "" }]);

    expect(result.valid).toBe(false);
    expect(result.layout).toBe("unknown");
    expect(result.errors).toContain(unsupportedLayoutMessage("unknown"));
    expect(unsupportedLayoutMessage("unknown")).toMatch(
      /^Missing agent\/instructions\.md, agent\/instructions\.ts, or agent\/instructions\/\. Eveland deploys one agent per repository/,
    );
  });

  // A build injects platform files into agent/, which turns a flat project
  // into an empty nested one that eve refuses for missing instructions; the
  // preflight names the layout instead.
  test("rejects eve's flat layout with an error that names it", () => {
    const result = inspectEveProject([
      { path: "package.json", content: JSON.stringify({ dependencies: { eve: "^1.0.0" } }) },
      { path: "instructions.md", content: "You are an agent." },
      { path: "agent.ts", content: "export default defineAgent({})" },
      { path: "schedules/daily.md", content: '---\ncron: "0 8 * * *"\n---\nReport.' },
    ]);

    expect(result.valid).toBe(false);
    expect(result.layout).toBe("flat");
    expect(result.errors).toEqual([unsupportedLayoutMessage("flat")]);
    expect(result.errors[0]).toContain("flat layout");
    expect(result.errors[0]).toContain(
      "Move instructions, agent.ts, and the agent's directories into agent/.",
    );
  });

  test("rejects an eve workspace of agents/<name>/ members", () => {
    const result = inspectEveProject([
      { path: "package.json", content: JSON.stringify({ dependencies: { eve: "^1.0.0" } }) },
      { path: "agents/support/instructions.md", content: "You are support." },
      { path: "agents/billing/instructions/system.md", content: "You are billing." },
    ]);

    expect(result.valid).toBe(false);
    expect(result.layout).toBe("workspace");
    expect(result.errors).toEqual([unsupportedLayoutMessage("workspace")]);
    expect(result.errors[0]).toContain("agents/<name>/");
  });

  test("accepts every instruction form eve authors", () => {
    for (const instructions of [
      "agent/instructions.md",
      "agent/instructions.mts",
      "agent/instructions.js",
      "agent/instructions/system.md",
    ]) {
      const result = inspectEveProject([
        { path: "package.json", content: JSON.stringify({ dependencies: { eve: "^1.0.0" } }) },
        { path: instructions, content: "You are an agent." },
      ]);
      expect(result.errors, instructions).toEqual([]);
      expect(result.layout).toBe("nested");
    }
  });

  // eve resolves agent/ ahead of root files, so a stray root instructions
  // file does not make a nested project flat.
  test("prefers agent/ when the root also has instructions", () => {
    const result = inspectEveProject([
      { path: "package.json", content: JSON.stringify({ dependencies: { eve: "^1.0.0" } }) },
      { path: "instructions.md", content: "Notes." },
      { path: "agent/instructions.md", content: "You are an agent." },
    ]);
    expect(result.valid).toBe(true);
    expect(result.layout).toBe("nested");
  });

  test("fails closed with a diagnostic when the declared Eve cannot resolve inside the window", () => {
    const result = inspectEveProject([
      { path: "package.json", content: JSON.stringify({ dependencies: { eve: "0.83.3" } }) },
      { path: "agent/instructions.md", content: "You are an agent." },
    ]);

    expect(result.valid).toBe(false);
    expect(result.eveVersion).toBe("0.83.3");
    expect(result.errors).toContain(unsupportedEveSpecifierMessage("0.83.3"));
  });

  test("accepts the caret range eve init writes", () => {
    const result = inspectEveProject([
      { path: "package.json", content: JSON.stringify({ dependencies: { eve: "^1.0.0" } }) },
      { path: "agent/instructions.md", content: "You are an agent." },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
