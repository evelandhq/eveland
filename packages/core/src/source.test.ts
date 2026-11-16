import { describe, expect, test } from "vitest";
import { unsupportedEveSpecifierMessage } from "./eve-compatibility.js";
import { inspectEveProject } from "./source.js";

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
    expect(result.capabilities).toEqual({ eveChat: true });
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

  test("does not declare eveChat for a non-canonical or unrelated Eve channel", () => {
    const result = inspectEveProject([
      { path: "package.json", content: JSON.stringify({ dependencies: { eve: "1.0.0" } }) },
      { path: "agent/instructions.md", content: "You are an agent." },
      {
        path: "agent/channels/eve.ts",
        content: `export default customChannel({ note: "eveChannel" });`,
      },
    ]);

    expect(result.capabilities).toEqual({ eveChat: false });
  });

  // A channel file of repeated unclosed import braces once made the eveChat
  // probe scan quadratically.
  test("probes a crafted channel file in linear time", () => {
    const started = performance.now();
    const result = inspectEveProject([
      { path: "package.json", content: JSON.stringify({ dependencies: { eve: "1.0.0" } }) },
      { path: "agent/instructions.md", content: "You are an agent." },
      { path: "agent/channels/eve.ts", content: "import{".repeat(20_000) },
    ]);
    expect(result.capabilities).toEqual({ eveChat: false });
    expect(performance.now() - started).toBeLessThan(200);
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

  test("rejects directories without root instructions", () => {
    const result = inspectEveProject([{ path: "agent/tools/get_weather.ts", content: "" }]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Missing root instructions.md, instructions.ts, or instructions/.",
    );
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
