import { describe, expect, test } from "vitest";
import { inspectEveProject, isSupportedEveDependency } from "./source.js";

describe("inspectEveProject", () => {
  test("recognizes nested eve agent layout and summarizes authored slots", () => {
    const result = inspectEveProject([
      { path: "package.json", content: JSON.stringify({ name: "weather-agent", dependencies: { eve: "0.24.4" } }) },
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
    expect(result.eveVersion).toBe("0.24.4");
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
      'Unsupported Eve dependency "0.22.6". Eveland requires Eve 0.24.x. Upgrade the project\'s "eve" dependency before importing or deploying.',
    );
  });

  test("accepts only dependency declarations contained inside Eve 0.24.x", () => {
    for (const version of ["0.24.0", "0.24.4", "~0.24.2", "^0.24.0", "0.24", "0.24.x", "0.24.*"]) {
      expect(isSupportedEveDependency(version)).toBe(true);
    }
    for (const version of ["0.22.6", "0.23.9", "0.25.0", ">=0.24.0", "*", "latest"]) {
      expect(isSupportedEveDependency(version)).toBe(false);
    }
  });
});

describe("inspectEveProject platform-owned workflow world", () => {
  test("does not inspect authored workflow configuration for a platform runtime concern", () => {
    const result = inspectEveProject([
      { path: "package.json", content: JSON.stringify({ dependencies: { eve: "0.24.x" } }) },
      { path: "agent/instructions.md", content: "You are an agent." },
      {
        path: "agent/agent.ts",
        content: `export default defineAgent({
  model: process.env.DEFAULT_MODEL,
  experimental: { workflow: { world: "@workflow/world-postgres" } },
})`,
      },
    ]);
    expect(result).not.toHaveProperty("workflowWorld");
  });
});
