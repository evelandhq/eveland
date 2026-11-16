import { describe, expect, test } from "vitest";
import * as Eve from "./eve.js";
import {
  getEveString,
  isDelegatedUsageRecord,
  isEveRecord,
  parseEveJsonObject,
  parseModelUsageEvent,
  parseUnreportedModelRun,
} from "./eve.js";

test("Eve wire helpers parse object payloads", () => {
  const parsed = parseEveJsonObject('{"sessionId":"eve_123","response":"hello"}');

  expect(isEveRecord(parsed)).toBe(true);
  expect(getEveString(parsed, "sessionId")).toBe("eve_123");
  expect(parseEveJsonObject("[]")).toBeNull();
  expect(parseEveJsonObject("not-json")).toBeNull();
});

describe("parseUnreportedModelRun", () => {
  test("a completed model run is a missing-usage candidate keyed by its run", () => {
    expect(
      parseUnreportedModelRun(
        "model.settled",
        { runId: "run_1", outcome: "completed", finishReason: "stop" },
        { turnId: "turn_1", runId: "run_1" },
      ),
    ).toEqual({
      turnId: "turn_1",
      runKey: "run:run_1",
      finishReason: "stop",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      usageReported: false,
    });
  });

  test("takes the run from scope when the fact omits it", () => {
    expect(
      parseUnreportedModelRun(
        "model.settled",
        { outcome: "completed" },
        { turnId: "t", runId: "r" },
      )?.runKey,
    ).toBe("run:r");
  });

  test("keys a positioned run under the commit line it settled on", () => {
    expect(
      parseUnreportedModelRun(
        "model.settled",
        { runId: "r", outcome: "completed" },
        { turnId: "t", runId: "r" },
        { line: 12, index: 3 },
      )?.runKey,
    ).toBe("run:r@line:12");
  });

  test("ignores runs that did not complete, other facts, and runs without an id", () => {
    expect(
      parseUnreportedModelRun("model.settled", { runId: "r", outcome: "failed" }, { turnId: "t" }),
    ).toBeNull();
    expect(
      parseUnreportedModelRun("model.started", { runId: "r", outcome: "completed" }, {}),
    ).toBeNull();
    expect(parseUnreportedModelRun("model.settled", { outcome: "completed" }, {})).toBeNull();
  });
});

describe("parseModelUsageEvent", () => {
  test("reads usage owned by a model run or a context change", () => {
    expect(
      parseModelUsageEvent(
        "usage.recorded",
        {
          kind: "model",
          owner: { runId: "run_7" },
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0.001,
          },
        },
        { turnId: "turn_3", runId: "run_7" },
      ),
    ).toEqual({
      turnId: "turn_3",
      runKey: "run:run_7",
      finishReason: null,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.001,
      usageReported: true,
    });
    expect(
      parseModelUsageEvent(
        "usage.recorded",
        {
          kind: "model",
          owner: { changeId: "chg_1" },
          usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
        { changeId: "chg_1" },
      ),
    ).toMatchObject({ turnId: "chg_1", runKey: "change:chg_1", costUsd: null });
  });

  test("keys a positioned run's record under its commit line, so a retried attempt's record stays apart", () => {
    const usage = { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const recorded = { kind: "model", owner: { runId: "r" }, usage };
    const scope = { turnId: "t", runId: "r" };
    // eve commits a retried attempt's record with `model.retried` and the
    // final one with `model.settled`: same run, different lines.
    expect(
      parseModelUsageEvent("usage.recorded", recorded, scope, { line: 4, index: 1 })?.runKey,
    ).toBe("run:r@line:4");
    expect(
      parseModelUsageEvent("usage.recorded", recorded, scope, { line: 9, index: 1 })?.runKey,
    ).toBe("run:r@line:9");
    // An unpositioned record, and a context change's record, keep their owner key.
    expect(parseModelUsageEvent("usage.recorded", recorded, scope)?.runKey).toBe("run:r");
    expect(
      parseModelUsageEvent(
        "usage.recorded",
        { kind: "model", owner: { changeId: "c" }, usage },
        { changeId: "c" },
        { line: 4, index: 0 },
      )?.runKey,
    ).toBe("change:c");
  });

  test("leaves delegated usage to the child session that recorded it", () => {
    const usage = { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const position = { line: 6, index: 2 };
    expect(
      parseModelUsageEvent(
        "usage.recorded",
        { kind: "model", owner: { callId: "call_1" }, usage },
        { turnId: "t" },
        position,
      ),
    ).toBeNull();
    expect(
      parseModelUsageEvent("usage.recorded", { kind: "delegated-late", usage }, {}, position),
    ).toBeNull();
    expect(
      parseModelUsageEvent("model.settled", { runId: "run_1", outcome: "completed" }),
    ).toBeNull();
    expect(isDelegatedUsageRecord({ kind: "model", owner: { callId: "call_1" }, usage })).toBe(
      true,
    );
    expect(isDelegatedUsageRecord({ kind: "delegated-late", usage })).toBe(true);
  });

  test("counts a decision's and an auxiliary call's spend on the session that made it, keyed by stream position", () => {
    const usage = { inputTokens: 40, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 };
    // `decide()` outside a tool records no owner; an auxiliary model call inside
    // a tool is owned by that call, but it is this session's own spend.
    const decision = { kind: "decision", usage: { ...usage, costUsd: 0.002 } };
    const auxiliary = { kind: "auxiliary", owner: { callId: "call_9" }, usage };
    expect(
      parseModelUsageEvent("usage.recorded", decision, { turnId: "turn_4" }, { line: 7, index: 2 }),
    ).toEqual({
      turnId: "turn_4",
      runKey: "record@line:7:2",
      finishReason: null,
      inputTokens: 40,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.002,
      usageReported: true,
    });
    expect(
      parseModelUsageEvent(
        "usage.recorded",
        auxiliary,
        { turnId: "turn_4" },
        { line: 8, index: 0 },
      ),
    ).toMatchObject({ turnId: "turn_4", runKey: "record@line:8:0", inputTokens: 40 });
    // Spend nothing owns (cache warming) is this session's own as well.
    expect(
      parseModelUsageEvent("usage.recorded", { kind: "model", usage }, {}, { line: 2, index: 0 }),
    ).toMatchObject({ turnId: "record@line:2:0", runKey: "record@line:2:0" });
    expect(isDelegatedUsageRecord(decision)).toBe(false);
    expect(isDelegatedUsageRecord(auxiliary)).toBe(false);
    // Without a stream position nothing makes the record idempotent.
    expect(parseModelUsageEvent("usage.recorded", decision, { turnId: "turn_4" })).toBeNull();
  });

  test("ignores every other event", () => {
    expect(parseModelUsageEvent("model.settled", { runId: "r", outcome: "completed" })).toBeNull();
    expect(parseModelUsageEvent("turn.settled", { turnId: "turn_0" })).toBeNull();
  });
});

describe("Eve session request classification", () => {
  test("classifies every canonical session operation with its decoded session identity", () => {
    const classify = (Eve as Record<string, unknown>).classifyEveSessionRequest;
    expect(classify).toBeTypeOf("function");
    if (typeof classify !== "function") return;

    expect(classify("POST", "/eve/v1/session")).toEqual({ kind: "initial", sessionId: null });
    // A bare `reset` segment is an ordinary (if odd) session id.
    expect(classify("POST", "/eve/v1/session/reset")).toEqual({
      kind: "continuation",
      sessionId: "reset",
    });
    expect(classify("POST", "/eve/v1/session/eve%2Fencoded")).toEqual({
      kind: "continuation",
      sessionId: "eve/encoded",
    });
    expect(classify("POST", "/eve/v1/session/eve_1/cancel")).toEqual({
      kind: "cancel",
      sessionId: "eve_1",
    });
    expect(classify("GET", "/eve/v1/session/eve_1/stream")).toEqual({
      kind: "stream",
      sessionId: "eve_1",
    });
    expect(
      classify("GET", "/eve/v1/session/eve%2Fparent/subagents/call%2F1/eve%2Fchild/stream"),
    ).toEqual({
      kind: "stream",
      sessionId: "eve/parent",
    });
    expect(classify("POST", "/eve/v1/session/eve_1/clear")).toEqual({
      kind: "clear",
      sessionId: "eve_1",
    });
    expect(classify("POST", "/eve/v1/session/eve_1/compact")).toEqual({
      kind: "compact",
      sessionId: "eve_1",
    });
    expect(classify("POST", "/eve/v1/session/eve_1/reset")).toEqual({
      kind: "reset",
      sessionId: "eve_1",
    });
    // `end` retires the session; `reset` is its alias.
    expect(classify("POST", "/eve/v1/session/eve_1/end")).toEqual({
      kind: "reset",
      sessionId: "eve_1",
    });
    // Eve follows every descendant session under its root's stream.
    expect(classify("GET", "/eve/v1/session/eve%2Froot/descendants/stream")).toEqual({
      kind: "stream",
      sessionId: "eve/root",
    });
    expect(classify("POST", "/eve/v1/session/eve_1/descendants/stream")).toBeNull();
    expect(classify("GET", "/eve/v1/session/eve_1/end")).toBeNull();
    expect(classify("GET", "/eve/v1/session/%E0%A4%A/descendants/stream")).toBeNull();
  });

  test("pins every other route under a session by that session", () => {
    const classify = Eve.classifyEveSessionRequest;
    // eve serves the session's tool stubs to `eve eval`; a route eve adds
    // under a session later is pinned the same way.
    expect(classify("GET", "/eve/v1/session/eve%2F1/stubs")).toEqual({
      kind: "session_route",
      sessionId: "eve/1",
    });
    expect(classify("POST", "/eve/v1/session/eve_1/unknown")).toEqual({
      kind: "session_route",
      sessionId: "eve_1",
    });
    expect(classify("GET", "/eve/v1/session/eve_parent/subagents/call_1/stream")).toEqual({
      kind: "session_route",
      sessionId: "eve_parent",
    });
    expect(classify("DELETE", "/eve/v1/session/eve_1/some/deeper/route")).toEqual({
      kind: "session_route",
      sessionId: "eve_1",
    });
  });

  test("rejects non-canonical methods, suffixes, queries, and malformed session identities", () => {
    const classify = (Eve as Record<string, unknown>).classifyEveSessionRequest;
    expect(classify).toBeTypeOf("function");
    if (typeof classify !== "function") return;

    expect(classify("GET", "/eve/v1/session")).toBeNull();
    expect(classify("POST", "/eve/v1/session/eve_1/stream")).toBeNull();
    expect(classify("GET", "/eve/v1/session/eve_1/clear")).toBeNull();
    expect(classify("GET", "/eve/v1/session/eve_1/compact")).toBeNull();
    expect(classify("GET", "/eve/v1/session/eve_1/reset")).toBeNull();
    expect(classify("GET", "/eve/v1/session/eve_1/stream?startIndex=1")).toBeNull();
    expect(
      classify("POST", "/eve/v1/session/eve_parent/subagents/call_1/eve_child/stream"),
    ).toBeNull();
    expect(
      classify("GET", "/eve/v1/session/eve_parent/subagents/%E0%A4%A/eve_child/stream"),
    ).toBeNull();
    expect(classify("POST", "/eve/v1/session/%E0%A4%A")).toBeNull();
    expect(classify("POST", "/other")).toBeNull();
    expect(classify("GET", "/eve/v1/session/eve_1/")).toBeNull();
    expect(classify("GET", "/eve/v1/session/%E0%A4%A/stubs")).toBeNull();

    expect(Eve.isEveSessionNamespace("/eve/v1/session/eve_1/unknown")).toBe(true);
    expect(Eve.isEveSessionNamespace("/eve/v1/session-like/eve_1")).toBe(false);
  });

  test("recognises the Workflow queue namespace the Gateway must refuse", () => {
    // eve mounts these under the fixed base path from @workflow/utils and
    // authenticates nothing on them, so the Gateway refuses the whole
    // namespace — including anything nested, which is where `step` lives.
    expect(Eve.isWorkflowQueueNamespace("/.well-known/workflow/v1")).toBe(true);
    expect(Eve.isWorkflowQueueNamespace("/.well-known/workflow/v1/flow")).toBe(true);
    expect(Eve.isWorkflowQueueNamespace("/.well-known/workflow/v1/step")).toBe(true);
    // A prefix that merely looks similar must still route: refusing it would
    // break an Agent that legitimately serves its own /.well-known paths.
    expect(Eve.isWorkflowQueueNamespace("/.well-known/workflow/v2/flow")).toBe(false);
    expect(Eve.isWorkflowQueueNamespace("/.well-known/workflow/v1x/flow")).toBe(false);
    expect(Eve.isWorkflowQueueNamespace("/.well-known/security.txt")).toBe(false);
    expect(Eve.isWorkflowQueueNamespace("/api/.well-known/workflow/v1/flow")).toBe(false);
  });

  test("carves the Workflow webhook resume route out of the refused namespace", () => {
    // eve serves `createWebhook()` URLs here on every method; the token
    // is the credential, so exactly this shape is forwarded as a public request.
    expect(Eve.isWorkflowWebhookRoute("/.well-known/workflow/v1/webhook/whk_1")).toBe(true);
    expect(Eve.isWorkflowWebhookRoute("/.well-known/workflow/v1/webhook/a.b-c_d")).toBe(true);
    // Still inside the refused namespace: the queue routes, a bare webhook
    // prefix without a token, and anything nested under a token.
    expect(Eve.isWorkflowWebhookRoute("/.well-known/workflow/v1/flow")).toBe(false);
    expect(Eve.isWorkflowWebhookRoute("/.well-known/workflow/v1/step")).toBe(false);
    expect(Eve.isWorkflowWebhookRoute("/.well-known/workflow/v1/webhook")).toBe(false);
    expect(Eve.isWorkflowWebhookRoute("/.well-known/workflow/v1/webhook/")).toBe(false);
    expect(Eve.isWorkflowWebhookRoute("/.well-known/workflow/v1/webhook/whk_1/extra")).toBe(false);
    expect(Eve.isWorkflowWebhookRoute("/.well-known/workflow/v2/webhook/whk_1")).toBe(false);
    // Every webhook route is inside the namespace the Gateway would otherwise refuse.
    expect(Eve.isWorkflowQueueNamespace("/.well-known/workflow/v1/webhook/whk_1")).toBe(true);
  });
});

describe("Playground turn validation", () => {
  test("accepts text and safe data-url attachments within the configured limits", () => {
    const validate = (Eve as Record<string, unknown>).validatePlaygroundTurn;
    expect(validate).toBeTypeOf("function");
    if (typeof validate !== "function") return;

    const payload = {
      message: [
        { type: "text", text: "Review these files" },
        {
          type: "file",
          data: "data:text/plain;base64,aGVsbG8=",
          filename: "notes.txt",
          mediaType: "text/plain",
        },
        {
          type: "file",
          data: "data:application/octet-stream;base64,e30=",
          filename: "config.json",
          mediaType: "application/octet-stream",
        },
      ],
    };

    expect(validate(payload, { maxFiles: 4, maxFileBytes: 8, maxTotalFileBytes: 16 })).toEqual(
      payload,
    );
  });

  test("rejects unsafe file types and attachment count or byte overflows", () => {
    const validate = (Eve as Record<string, unknown>).validatePlaygroundTurn;
    expect(validate).toBeTypeOf("function");
    if (typeof validate !== "function") return;

    const file = {
      type: "file",
      data: "data:text/plain;base64,aGVsbG8=",
      filename: "notes.txt",
      mediaType: "text/plain",
    };

    expect(() =>
      validate({ message: [file, file] }, { maxFiles: 1, maxFileBytes: 8, maxTotalFileBytes: 16 }),
    ).toThrow(/at most 1 file/i);
    expect(() =>
      validate({ message: [file] }, { maxFiles: 4, maxFileBytes: 4, maxTotalFileBytes: 16 }),
    ).toThrow(/5 bytes.*4 bytes/i);
    expect(() =>
      validate(
        {
          message: [
            {
              ...file,
              data: "data:application/zip;base64,UEsDBA==",
              filename: "source.zip",
              mediaType: "application/zip",
            },
          ],
        },
        { maxFiles: 4, maxFileBytes: 8, maxTotalFileBytes: 16 },
      ),
    ).toThrow(/not supported/i);
  });

  test("accepts answer-only continuations but rejects empty turns", () => {
    const validate = Eve.validatePlaygroundTurn;
    expect(validate({ answers: [{ interactionId: "int_1", optionId: "approve" }] })).toMatchObject({
      answers: [{ interactionId: "int_1", optionId: "approve" }],
    });
    expect(
      validate({ message: "hi", answers: [{ interactionId: "int_1", text: "yes" }] }),
    ).toBeTruthy();
    expect(() => validate({ continuationToken: "continue_1" })).toThrow(/message or an answer/i);
    expect(() => validate({ answers: [] })).toThrow(/message or an answer/i);
    expect(() => validate({ message: "hi", answers: [] })).toThrow(/non-empty array/i);
    expect(() => validate({ answers: [{ optionId: "approve" }] })).toThrow(/interaction ID/i);
    expect(() => validate({ answers: [{ interactionId: "int_1", text: " " }] })).toThrow(
      /option or text value/i,
    );
  });
});

describe("eve event projections", () => {
  test("maps settled outcomes and pauses onto the scheduled-execution outcome", () => {
    const { scheduleExecutionStatusFromEveEvent, EVE_SESSION_BOUNDARY_EVENT_TYPES } = Eve;
    const settled = (outcome: string) => ({ turnId: "t", outcome });
    expect(scheduleExecutionStatusFromEveEvent("turn.settled", settled("completed"))).toBe(
      "succeeded",
    );
    expect(scheduleExecutionStatusFromEveEvent("turn.settled", settled("failed"))).toBe("failed");
    expect(scheduleExecutionStatusFromEveEvent("turn.settled", settled("cancelled"))).toBe(
      "failed",
    );
    expect(scheduleExecutionStatusFromEveEvent("session.ended", settled("failed"))).toBe("failed");
    // A turn pauses only for a person.
    expect(scheduleExecutionStatusFromEveEvent("turn.paused")).toBe("parked");
    // An unknown or missing outcome never settles the run, and anything
    // outside the boundary vocabulary keeps it running.
    expect(scheduleExecutionStatusFromEveEvent("turn.settled")).toBe("running");
    expect(scheduleExecutionStatusFromEveEvent("turn.settled", settled("later"))).toBe("running");
    expect(scheduleExecutionStatusFromEveEvent("model.settled")).toBe("running");
    expect(scheduleExecutionStatusFromEveEvent(undefined)).toBe("running");
    // Every declared boundary event resolves to a non-running outcome.
    for (const type of EVE_SESSION_BOUNDARY_EVENT_TYPES) {
      expect(scheduleExecutionStatusFromEveEvent(type, settled("completed"))).not.toBe("running");
    }
  });

  test("projects session status from interactions and settled outcomes", () => {
    const { sessionStatusFromEveEvent } = Eve;
    expect(sessionStatusFromEveEvent("session.started", "running")).toBe("running");
    let status = sessionStatusFromEveEvent("turn.started", "waiting", { turnId: "t" })!;
    expect(status).toBe("running");
    status = sessionStatusFromEveEvent("interaction.opened", status)!;
    expect(status).toBe("waiting_approval");
    status = sessionStatusFromEveEvent("interaction.settled", status)!;
    expect(status).toBe("running");
    // Another interaction is still open: eve pauses the same turn again.
    status = sessionStatusFromEveEvent("turn.paused", status)!;
    expect(status).toBe("waiting_approval");
    expect(sessionStatusFromEveEvent("interaction.settled", "waiting")).toBeNull();
    expect(sessionStatusFromEveEvent("turn.settled", "running", { outcome: "failed" })).toBe(
      "waiting",
    );
    expect(sessionStatusFromEveEvent("session.ended", "running", { outcome: "completed" })).toBe(
      "completed",
    );
    expect(sessionStatusFromEveEvent("session.ended", "running", { outcome: "failed" })).toBe(
      "failed",
    );
    expect(sessionStatusFromEveEvent("session.ended", "running")).toBeNull();
    expect(sessionStatusFromEveEvent("usage.recorded", "running")).toBeNull();
  });

  test("renders the Session failure line from the boundary payload", () => {
    const { sessionErrorFromEveEvent } = Eve;
    expect(
      sessionErrorFromEveEvent("session.ended", {
        outcome: "failed",
        error: { code: "MODEL_CALL_FAILED", message: "boom" },
      }),
    ).toBe("boom");
    expect(sessionErrorFromEveEvent("session.ended", { outcome: "failed" })).toBe(
      "The agent reported session.ended without a message.",
    );
    expect(sessionErrorFromEveEvent(undefined, "not a record")).toBe(
      "The agent reported session.ended without a message.",
    );
  });

  test("renders the scheduled-execution failure line from the boundary payload", () => {
    const { scheduleExecutionErrorFromEveEvent } = Eve;
    expect(
      scheduleExecutionErrorFromEveEvent("turn.settled", {
        outcome: "failed",
        error: { code: "X", message: "boom" },
      }),
    ).toBe("Scheduled Session turn.settled (failed): boom");
    expect(scheduleExecutionErrorFromEveEvent("turn.settled", { outcome: "cancelled" })).toBe(
      "Scheduled Session ended with turn.settled (cancelled).",
    );
    expect(
      scheduleExecutionErrorFromEveEvent(undefined, { error: { code: "X", message: "boom" } }),
    ).toBe("Scheduled Session failed: boom");
    expect(scheduleExecutionErrorFromEveEvent(undefined, "not a record")).toBe(
      "Scheduled Session ended with failure.",
    );
  });
});

// Crafted inputs that once made a validation regex backtrack exponentially or
// quadratically. Each finishes in well under the bound once the pattern has
// no ambiguous repetition; the slow form took seconds on these sizes.
describe("Playground file validation on crafted data URLs", () => {
  test("rejects a data URL of repeated parameter separators in linear time", () => {
    const validate = (Eve as Record<string, unknown>).validatePlaygroundTurn;
    if (typeof validate !== "function") throw new Error("validatePlaygroundTurn is missing");
    const file = {
      type: "file",
      data: `data:text/plain${";".repeat(26)};base64,!`,
      filename: "notes.txt",
      mediaType: "text/plain",
    };
    const started = performance.now();
    expect(() =>
      validate({ message: [file] }, { maxFiles: 4, maxFileBytes: 8, maxTotalFileBytes: 16 }),
    ).toThrow(/matching base64 data URLs/);
    expect(performance.now() - started).toBeLessThan(200);
  });

  test("still accepts data URL parameters before base64", () => {
    const validate = (Eve as Record<string, unknown>).validatePlaygroundTurn;
    if (typeof validate !== "function") throw new Error("validatePlaygroundTurn is missing");
    const payload = {
      message: [
        {
          type: "file",
          data: "data:text/plain;charset=utf-8;name=a;base64,aGVsbG8=",
          filename: "notes.txt",
          mediaType: "text/plain",
        },
      ],
    };
    expect(validate(payload, { maxFiles: 4, maxFileBytes: 8, maxTotalFileBytes: 16 })).toEqual(
      payload,
    );
  });
});
