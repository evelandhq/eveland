import { describe, expect, test } from "vitest";
import * as Eve from "./eve.js";
import { getEveString, isEveRecord, parseEveJsonObject, parseStepUsageEvent } from "./eve.js";

test("Eve wire helpers parse object payloads", () => {
  const parsed = parseEveJsonObject('{"sessionId":"eve_123","response":"hello"}');

  expect(isEveRecord(parsed)).toBe(true);
  expect(getEveString(parsed, "sessionId")).toBe("eve_123");
  expect(parseEveJsonObject("[]")).toBeNull();
  expect(parseEveJsonObject("not-json")).toBeNull();
});

describe("parseStepUsageEvent", () => {
  test("normalizes provider-reported usage from a completed model step", () => {
    expect(
      parseStepUsageEvent("step.completed", {
        turnId: "turn_2",
        stepIndex: 3,
        finishReason: "stop",
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 80,
          cacheWriteTokens: 10,
          costUsd: 0.0042,
        },
      }),
    ).toEqual({
      turnId: "turn_2",
      stepIndex: 3,
      finishReason: "stop",
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      costUsd: 0.0042,
      usageReported: true,
    });
  });

  test("keeps unavailable usage fields distinct from zero", () => {
    expect(
      parseStepUsageEvent("step.completed", {
        turnId: "turn_0",
        stepIndex: 0,
        finishReason: "tool-calls",
        usage: { inputTokens: 42 },
      }),
    ).toEqual({
      turnId: "turn_0",
      stepIndex: 0,
      finishReason: "tool-calls",
      inputTokens: 42,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      usageReported: true,
    });
  });

  test("records a completed step whose provider omitted usage", () => {
    expect(
      parseStepUsageEvent("step.completed", {
        turnId: "turn_0",
        stepIndex: 0,
        finishReason: "stop",
      }),
    ).toEqual({
      turnId: "turn_0",
      stepIndex: 0,
      finishReason: "stop",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      usageReported: false,
    });
  });

  test("ignores events that cannot identify a completed model step", () => {
    expect(parseStepUsageEvent("turn.completed", { turnId: "turn_0", stepIndex: 0 })).toBeNull();
    expect(parseStepUsageEvent("step.completed", { turnId: "turn_0" })).toBeNull();
  });
});

describe("Eve session request classification", () => {
  test("classifies every canonical session operation with its decoded session identity", () => {
    const classify = (Eve as Record<string, unknown>).classifyEveSessionRequest;
    expect(classify).toBeTypeOf("function");
    if (typeof classify !== "function") return;

    expect(classify("POST", "/eve/v1/session")).toEqual({ kind: "initial", sessionId: null });
    // The pre-0.31 tokenless reset route is gone; the path segment now reads
    // as an ordinary (if odd) session id, exactly like any other segment.
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
    // Eve 0.33 moved clear/compact/reset onto ID-addressed control routes.
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
    expect(classify("POST", "/eve/v1/session/eve_1/unknown")).toBeNull();
    expect(
      classify("POST", "/eve/v1/session/eve_parent/subagents/call_1/eve_child/stream"),
    ).toBeNull();
    expect(classify("GET", "/eve/v1/session/eve_parent/subagents/call_1/stream")).toBeNull();
    expect(
      classify("GET", "/eve/v1/session/eve_parent/subagents/%E0%A4%A/eve_child/stream"),
    ).toBeNull();
    expect(classify("POST", "/eve/v1/session/%E0%A4%A")).toBeNull();
    expect(classify("POST", "/other")).toBeNull();

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

  test("classifies only the canonical Eve task-input callback", () => {
    const classify = (Eve as Record<string, unknown>).classifyEveTaskInputRequest;
    expect(classify).toBeTypeOf("function");
    if (typeof classify !== "function") return;

    expect(classify("POST", "/eve/v1/task-input/eve%3Atask-input%3Aabc")).toEqual({
      kind: "task_input",
      token: "eve:task-input:abc",
    });
    expect(classify("GET", "/eve/v1/task-input/token")).toBeNull();
    expect(classify("POST", "/eve/v1/task-input/%E0%A4%A")).toBeNull();
    expect(classify("POST", "/eve/v1/task-input/token/nested")).toBeNull();
    expect(Eve.isEveTaskInputNamespace("/eve/v1/task-input/token")).toBe(true);
    expect(Eve.isEveTaskInputNamespace("/eve/v1/task-input-like/token")).toBe(false);
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

  test("accepts HITL-only continuations but rejects empty turns", () => {
    const validate = (Eve as Record<string, unknown>).validatePlaygroundTurn;
    expect(validate).toBeTypeOf("function");
    if (typeof validate !== "function") return;

    expect(
      validate({
        continuationToken: "continue_1",
        inputResponses: [{ requestId: "request_1", optionId: "approve" }],
      }),
    ).toMatchObject({ inputResponses: [{ requestId: "request_1", optionId: "approve" }] });
    expect(() => validate({ continuationToken: "continue_1" })).toThrow(
      /message or input response/i,
    );
    expect(() => validate({ inputResponses: [{ requestId: "request_1", text: "" }] })).toThrow(
      /option or text value/i,
    );
    expect(() => validate({ inputResponses: [{ requestId: "request_1", optionId: "" }] })).toThrow(
      /option or text value/i,
    );
  });
});

describe("eve event projections", () => {
  test("maps every boundary event onto the scheduled-execution outcome", () => {
    const { scheduleExecutionStatusFromEveEvent, EVE_SESSION_BOUNDARY_EVENT_TYPES } = Eve;
    expect(scheduleExecutionStatusFromEveEvent("turn.completed", "completed")).toBe("succeeded");
    expect(scheduleExecutionStatusFromEveEvent("session.completed", "completed")).toBe("succeeded");
    expect(scheduleExecutionStatusFromEveEvent("turn.failed", "failed")).toBe("failed");
    expect(scheduleExecutionStatusFromEveEvent("turn.cancelled", "running")).toBe("failed");
    expect(scheduleExecutionStatusFromEveEvent("session.failed", "failed")).toBe("failed");
    expect(scheduleExecutionStatusFromEveEvent("session.waiting", "waiting_approval")).toBe(
      "parked",
    );
    expect(scheduleExecutionStatusFromEveEvent("session.waiting", "waiting")).toBe("succeeded");
    // Total mapping: anything outside the boundary vocabulary keeps running.
    expect(scheduleExecutionStatusFromEveEvent("step.completed", "running")).toBe("running");
    expect(scheduleExecutionStatusFromEveEvent(undefined, "running")).toBe("running");
    // Every declared boundary event resolves to a non-running outcome.
    for (const type of EVE_SESSION_BOUNDARY_EVENT_TYPES) {
      expect(scheduleExecutionStatusFromEveEvent(type, "running")).not.toBe("running");
    }
  });

  test("projects session status transitions including the approval-parked hold", () => {
    const { sessionStatusFromEveEvent } = Eve;
    expect(sessionStatusFromEveEvent("session.started", "running")).toBe("running");
    expect(sessionStatusFromEveEvent("turn.started", "waiting")).toBe("running");
    expect(sessionStatusFromEveEvent("input.requested", "running")).toBe("waiting_approval");
    expect(sessionStatusFromEveEvent("session.waiting", "waiting_approval")).toBe(
      "waiting_approval",
    );
    expect(sessionStatusFromEveEvent("session.waiting", "running")).toBe("waiting");
    expect(sessionStatusFromEveEvent("session.completed", "running")).toBe("completed");
    expect(sessionStatusFromEveEvent("session.failed", "running")).toBe("failed");
    expect(sessionStatusFromEveEvent("step.completed", "running")).toBeNull();
  });

  test("renders the Session failure line from the boundary payload", () => {
    const { sessionErrorFromEveEvent } = Eve;
    expect(sessionErrorFromEveEvent("session.failed", { message: "boom" })).toBe("boom");
    expect(sessionErrorFromEveEvent("session.failed", {})).toBe(
      "The agent reported session.failed without a message.",
    );
    expect(sessionErrorFromEveEvent(undefined, "not a record")).toBe(
      "The agent reported session.failed without a message.",
    );
  });

  test("renders the scheduled-execution failure line from the boundary payload", () => {
    const { scheduleExecutionErrorFromEveEvent } = Eve;
    expect(scheduleExecutionErrorFromEveEvent("turn.failed", { message: "boom" })).toBe(
      "Scheduled Session turn.failed: boom",
    );
    expect(scheduleExecutionErrorFromEveEvent("turn.failed", {})).toBe(
      "Scheduled Session ended with turn.failed.",
    );
    expect(scheduleExecutionErrorFromEveEvent(undefined, { message: "boom" })).toBe(
      "Scheduled Session failed: boom",
    );
    expect(scheduleExecutionErrorFromEveEvent(undefined, "not a record")).toBe(
      "Scheduled Session ended with failure.",
    );
  });
});
