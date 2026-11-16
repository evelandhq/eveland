import { describe, expect, test } from "vitest";
import { projectEveInfo } from "./discovery.js";

// The fields `eve info --json` documents, as eve 1.0.0 prints them for a
// nested agent (`toolInputSchemas` and `artifacts` are left out of the
// summary). The drift guard against what eve actually prints is the
// agent-observer compatibility test, which runs this projection on the live
// output of the pinned eve binary.
const info = {
  appRoot: "/srv/app",
  agentRoot: "/srv/app/agent",
  layout: "nested",
  status: "ready",
  diagnostics: { errors: 0, warnings: 1 },
  model: "zai/glm-5.2",
  instructions: "instructions.md (system)",
  skills: ["compatibility"],
  tools: ["bash", "lookup"],
  toolInputSchemas: { root: {}, subagents: {} },
  subagents: ["reviewer", "crm__quick"],
  schedules: ["digest", "crm__sync"],
  channels: [
    { name: "eve", kind: "http", method: "GET", urlPath: "/eve/v1/health" },
    { name: "eve", kind: "http", method: "POST", urlPath: "/eve/v1/session" },
    { name: "eveland-scheduler", kind: "http", method: "POST", urlPath: "/eveland/scheduler/:id" },
  ],
  messaging: {
    create: "/eve/v1/session",
    messages: "/eve/v1/session/:sessionId",
    stream: "/eve/v1/session/:sessionId/stream",
  },
  artifacts: { discoveryManifest: "/srv/app/.eve/discovery/agent-discovery-manifest.json" },
};

describe("projectEveInfo", () => {
  test("projects eve's documented info output onto the build summary", () => {
    expect(projectEveInfo(info)).toEqual({
      summarySource: "eve-info",
      status: "ready",
      layout: "nested",
      diagnostics: { errors: 0, warnings: 1 },
      model: "zai/glm-5.2",
      instructions: "instructions.md (system)",
      skills: ["compatibility"],
      tools: ["bash", "lookup"],
      subagents: ["reviewer", "crm__quick"],
      schedules: ["digest", "crm__sync"],
      channels: ["eve", "eveland-scheduler"],
    });
  });

  test("keeps eve's nulls for a project it could not compile", () => {
    expect(
      projectEveInfo({
        ...info,
        agentRoot: null,
        layout: null,
        status: "unavailable",
        diagnostics: null,
        model: null,
        instructions: null,
        skills: [],
        tools: [],
        subagents: [],
        schedules: [],
        channels: [],
      }),
    ).toMatchObject({
      status: "unavailable",
      layout: null,
      diagnostics: null,
      model: null,
      instructions: null,
    });
  });

  // The summary replaces the static scan's entity lists, so output it does
  // not recognize must not become authoritative emptiness.
  test.each([
    ["not an object", null],
    ["an array", []],
    ["no status", { ...info, status: undefined }],
    ["a list that is not a list", { ...info, tools: "bash" }],
    ["a list holding a non-string", { ...info, schedules: ["digest", 3] }],
    ["a channel without a name", { ...info, channels: [{ kind: "http" }] }],
    ["malformed diagnostics", { ...info, diagnostics: { errors: "0" } }],
  ])("fails closed on %s", (_label, value) => {
    expect(projectEveInfo(value)).toBeNull();
  });
});
