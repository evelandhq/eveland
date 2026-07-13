import { describe, expect, test } from "vitest";
import { inspectEveProject, isDurableWorkflowWorld } from "./source.js";

describe("inspectEveProject", () => {
  test("recognizes nested eve agent layout and summarizes authored slots", () => {
    const result = inspectEveProject([
      { path: "package.json", content: JSON.stringify({ name: "weather-agent" }) },
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
});

describe("inspectEveProject workflow world detection", () => {
  test("detects the configured workflow world from agent.ts", () => {
    const result = inspectEveProject([
      { path: "agent/instructions.md", content: "You are an agent." },
      {
        path: "agent/agent.ts",
        content: `export default defineAgent({
  model: process.env.DEFAULT_MODEL,
  experimental: { workflow: { world: "@workflow/world-postgres" } },
})`,
      },
    ]);
    expect(result.workflowWorld).toBe("@workflow/world-postgres");
  });

  test("reports no workflow world when agent.ts does not configure one", () => {
    const result = inspectEveProject([
      { path: "agent/instructions.md", content: "You are an agent." },
      { path: "agent/agent.ts", content: `export default defineAgent({ model: process.env.DEFAULT_MODEL })` },
    ]);
    expect(result.workflowWorld).toBeNull();
  });

  test("ignores a world literal outside experimental.workflow", () => {
    const result = inspectEveProject([
      { path: "agent/instructions.md", content: "You are an agent." },
      {
        path: "agent/agent.ts",
        content: `const unused = { world: "@workflow/world-postgres" };
export default defineAgent({ model: process.env.DEFAULT_MODEL })`,
      },
    ]);
    expect(result.workflowWorld).toBeNull();
  });
});

describe("isDurableWorkflowWorld", () => {
  test("treats @workflow/world-postgres as durable", () => {
    expect(isDurableWorkflowWorld("@workflow/world-postgres")).toBe(true);
  });

  test("treats local, other, and unconfigured worlds as non-durable", () => {
    expect(isDurableWorkflowWorld("@workflow/world-local")).toBe(false);
    expect(isDurableWorkflowWorld("@workflow/world-redis")).toBe(false);
    expect(isDurableWorkflowWorld(null)).toBe(false);
    expect(isDurableWorkflowWorld(undefined)).toBe(false);
  });
});
