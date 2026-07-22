import { describe, expect, test } from "vitest";
import { createEveVersionInfo, inspectEveProject, isSupportedEveDependency } from "./source.js";

describe("inspectEveProject", () => {
  test("recognizes nested eve agent layout and summarizes authored slots", () => {
    const result = inspectEveProject([
      { path: "package.json", content: JSON.stringify({ name: "weather-agent", dependencies: { eve: "0.25.1" } }) },
      { path: "agent/agent.ts", content: `export default defineAgent({ model: process.env.DEFAULT_MODEL })` },
      { path: "agent/instructions.md", content: "You are a weather agent." },
      { path: "agent/tools/get_weather.ts", content: "export default defineTool({})" },
      { path: "agent/skills/report.md", content: "---\ndescription: Report\n---" },
      { path: "agent/connections/linear.ts", content: "process.env.LINEAR_API_TOKEN" },
      { path: "agent/subagents/researcher/agent.ts", content: "export default defineAgent({ description: 'Research' })" },
      { path: "agent/sandbox/sandbox.ts", content: "export default defineSandbox({})" },
      { path: "agent/schedules/daily.md", content: "---\ncron: \"0 8 * * *\"\n---\nReport." },
      { path: ".env.example", content: "OPENAI_API_KEY=\nANTHROPIC_API_KEY=example\n" },
    ]);

    expect(result.valid).toBe(true);
    expect(result.layout).toBe("nested");
    expect(result.projectName).toBe("weather-agent");
    expect(result.eveVersion).toBe("0.25.1");
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
    expect(result.envVars).toEqual(["ANTHROPIC_API_KEY", "DEFAULT_MODEL", "LINEAR_API_TOKEN", "OPENAI_API_KEY"]);
  });

  test("uses Eve's authored skill extensions in the source summary", () => {
    const result = inspectEveProject([
      { path: "package.json", content: JSON.stringify({ dependencies: { eve: "0.25.1" } }) },
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
    expect(result.errors).toContain("Missing root instructions.md, instructions.ts, or instructions/.");
  });

  test("fails closed with an upgrade diagnostic outside the supported Eve line", () => {
    const result = inspectEveProject([
      { path: "package.json", content: JSON.stringify({ dependencies: { eve: "0.22.6" } }) },
      { path: "agent/instructions.md", content: "You are an agent." },
    ]);

    expect(result.valid).toBe(false);
    expect(result.eveVersion).toBe("0.22.6");
    expect(result.errors).toContain(
      'Unsupported Eve dependency "0.22.6". Eveland requires Eve 0.25.x, 0.26.x, or 0.27.x. Upgrade the project\'s "eve" dependency before importing or deploying.',
    );
  });

  test("accepts dependency declarations contained inside the three verified Eve minors", () => {
    for (const version of [
      "0.25.0", "0.25.3", "~0.25.2", "^0.25.0", "0.25", "0.25.x", "0.25.*",
      "0.26.0", "0.26.2", "~0.26.1", "^0.26.0", "0.26", "0.26.x", "0.26.*",
      "0.27.0", "~0.27.0", "^0.27.0", "0.27", "0.27.x", "0.27.*",
    ]) {
      expect(isSupportedEveDependency(version)).toBe(true);
    }
    for (const version of ["0.24.6", "0.28.0", ">=0.25.0", ">=0.26.0", ">=0.27.0", "*", "latest"]) {
      expect(isSupportedEveDependency(version)).toBe(false);
    }
  });

  test("reports the sliding compatibility window as structured ranges", () => {
    expect(createEveVersionInfo("0.27.0", "src_1")).toEqual({
      version: "0.27.0",
      expected: "0.25.x, 0.26.x, or 0.27.x",
      supportedRanges: ["0.25.x", "0.26.x", "0.27.x"],
      supported: true,
      sourceRevisionId: "src_1",
    });
  });
});
