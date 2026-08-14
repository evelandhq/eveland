import { describe, expect, test } from "vitest";
import {
  createEveVersionInfo,
  inspectEveProject,
  isSupportedEveDependency,
  isUnsupportedEveVersionMessage,
  unsupportedEveVersionMessage,
} from "./source.js";

describe("inspectEveProject", () => {
  test("recognizes nested eve agent layout and summarizes authored slots", () => {
    const result = inspectEveProject([
      {
        path: "package.json",
        content: JSON.stringify({ name: "weather-agent", dependencies: { eve: "0.34.5" } }),
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
    expect(result.eveVersion).toBe("0.34.5");
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
      { path: "package.json", content: JSON.stringify({ dependencies: { eve: "0.34.5" } }) },
      { path: "agent/instructions.md", content: "You are an agent." },
      {
        path: "agent/channels/eve.ts",
        content: `export default customChannel({ note: "eveChannel" });`,
      },
    ]);

    expect(result.capabilities).toEqual({ eveChat: false });
  });

  test("uses Eve's authored skill extensions in the source summary", () => {
    const result = inspectEveProject([
      { path: "package.json", content: JSON.stringify({ dependencies: { eve: "0.34.5" } }) },
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

  test("fails closed with an upgrade diagnostic outside the supported Eve line", () => {
    const result = inspectEveProject([
      { path: "package.json", content: JSON.stringify({ dependencies: { eve: "0.22.6" } }) },
      { path: "agent/instructions.md", content: "You are an agent." },
    ]);

    expect(result.valid).toBe(false);
    expect(result.eveVersion).toBe("0.22.6");
    expect(result.errors).toContain(
      'Unsupported Eve dependency "0.22.6". Eveland requires Eve 0.34.x, 0.35.x, 0.36.x, or 0.37.x. Upgrade the project\'s "eve" dependency before importing or deploying.',
    );
  });

  test("accepts dependency declarations contained inside the four verified Eve minors", () => {
    for (const version of [
      "0.34.0",
      "0.34.7",
      "~0.34.0",
      "^0.34.0",
      "0.34",
      "0.34.x",
      "0.34.*",
      "0.35.0",
      "0.35.6",
      "~0.35.2",
      "^0.35.0",
      "0.35",
      "0.35.x",
      "0.35.*",
      "0.36.0",
      "0.36.4",
      "~0.36.1",
      "^0.36.0",
      "0.36",
      "0.36.x",
      "0.36.*",
      "0.37.0",
      "~0.37.0",
      "^0.37.0",
      "0.37",
      "0.37.x",
      "0.37.*",
    ]) {
      expect(isSupportedEveDependency(version)).toBe(true);
    }
    for (const version of [
      "0.30.8",
      "0.31.3",
      "0.32.5",
      "0.33.3",
      ">=0.34.0",
      ">=0.37.0",
      "0.38.0",
      "*",
      "latest",
    ]) {
      expect(isSupportedEveDependency(version)).toBe(false);
    }
  });

  test("recognizes its own gate message after it has been reduced to plain text", () => {
    for (const specifier of ["0.31.1", "^0.31.0", null]) {
      expect(isUnsupportedEveVersionMessage(unsupportedEveVersionMessage(specifier))).toBe(true);
    }
    for (const message of [
      "Runtime activation timed out after 30000ms.",
      "Deployment is still draining.",
      "RuntimeInstance disappeared during activation.",
    ]) {
      expect(isUnsupportedEveVersionMessage(message)).toBe(false);
    }
  });

  test("reports the sliding compatibility window as structured ranges", () => {
    expect(createEveVersionInfo("0.37.0", "src_1")).toEqual({
      version: "0.37.0",
      expected: "0.34.x, 0.35.x, 0.36.x, or 0.37.x",
      supportedRanges: ["0.34.x", "0.35.x", "0.36.x", "0.37.x"],
      supported: true,
      sourceRevisionId: "src_1",
    });
  });
});
