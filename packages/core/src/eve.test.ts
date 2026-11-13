import { describe, expect, test } from "vitest";
import * as Eve from "./eve.js";
import {
  getEveString,
  isEveRecord,
  parseEveJsonObject,
  parseStepUsageEvent,
  parseUnreportedModelRun,
  unsegmentedRunKey,
} from "./eve.js";

test("Eve wire helpers parse object payloads", () => {
  const parsed = parseEveJsonObject('{"sessionId":"eve_123","response":"hello"}');

  expect(isEveRecord(parsed)).toBe(true);
  expect(getEveString(parsed, "sessionId")).toBe("eve_123");
  expect(parseEveJsonObject("[]")).toBeNull();
  expect(parseEveJsonObject("not-json")).toBeNull();
});

describe("parseUnreportedModelRun", () => {
  test("a completed v27 model run is a missing-usage candidate keyed by its run", () => {
    expect(
      parseUnreportedModelRun(
        "model.settled",
        { runId: "run_1", outcome: "completed", finishReason: "stop" },
        { turnId: "turn_1", runId: "run_1" },
      ),
    ).toEqual({
      turnId: "turn_1",
      stepIndex: null,
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
      runKey: null,
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
      runKey: null,
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
      runKey: null,
      finishReason: "stop",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      usageReported: false,
    });
  });

  test("reads v27 usage owned by a model run or a context change", () => {
    expect(
      parseStepUsageEvent(
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
      stepIndex: null,
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
      parseStepUsageEvent(
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
    // eve 1.0.0-rc.11+ commits a retried attempt's record with `model.retried`
    // and the final one with `model.settled`: same run, different lines.
    expect(
      parseStepUsageEvent("usage.recorded", recorded, scope, { line: 4, index: 1 })?.runKey,
    ).toBe("run:r@line:4");
    expect(
      parseStepUsageEvent("usage.recorded", recorded, scope, { line: 9, index: 1 })?.runKey,
    ).toBe("run:r@line:9");
    // An unpositioned record, and a context change's record, keep their owner key.
    expect(parseStepUsageEvent("usage.recorded", recorded, scope)?.runKey).toBe("run:r");
    expect(
      parseStepUsageEvent(
        "usage.recorded",
        { kind: "model", owner: { changeId: "c" }, usage },
        { changeId: "c" },
        { line: 4, index: 0 },
      )?.runKey,
    ).toBe("change:c");
  });

  test("names the owner key a commit-line run key replaced", () => {
    expect(unsegmentedRunKey("run:r@line:12")).toBe("run:r");
    expect(unsegmentedRunKey("run:r")).toBeNull();
    expect(unsegmentedRunKey("change:c")).toBeNull();
  });

  test("leaves delegated v27 usage to the child session that recorded it", () => {
    const usage = { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(
      parseStepUsageEvent("usage.recorded", { kind: "model", owner: { callId: "call_1" }, usage }),
    ).toBeNull();
    expect(parseStepUsageEvent("usage.recorded", { kind: "delegated-late", usage })).toBeNull();
    expect(
      parseStepUsageEvent("model.settled", { runId: "run_1", outcome: "completed" }),
    ).toBeNull();
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
    // Eve 0.87 renamed retirement to `end` and kept `reset` as its alias.
    expect(classify("POST", "/eve/v1/session/eve_1/end")).toEqual({
      kind: "reset",
      sessionId: "eve_1",
    });
    // Eve 0.84 follows every descendant session under its root's stream.
    expect(classify("GET", "/eve/v1/session/eve%2Froot/descendants/stream")).toEqual({
      kind: "stream",
      sessionId: "eve/root",
    });
    expect(classify("POST", "/eve/v1/session/eve_1/descendants/stream")).toBeNull();
    expect(classify("GET", "/eve/v1/session/eve_1/end")).toBeNull();
    expect(classify("GET", "/eve/v1/session/%E0%A4%A/descendants/stream")).toBeNull();
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

  test("carves the Workflow webhook resume route out of the refused namespace", () => {
    // eve 0.48 serves `createWebhook()` URLs here on every method; the token
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
    // 0.69: a question inside a running call parks the turn without ending it.
    expect(scheduleExecutionStatusFromEveEvent("turn.waiting", "waiting_approval")).toBe("parked");
    // A turn waiting on its own tasks is still running.
    expect(scheduleExecutionStatusFromEveEvent("turn.waiting", "running")).toBe("running");
    // 0.70: a schedule whose turn holds for a sign-in parks like one holding
    // for an approval, once the sign-in moved the session to waiting_approval.
    expect(
      scheduleExecutionStatusFromEveEvent(
        "turn.waiting",
        Eve.sessionStatusFromEveEvent("authorization.required", "running")!,
      ),
    ).toBe("parked");
    // Total mapping: anything outside the boundary vocabulary keeps running.
    expect(scheduleExecutionStatusFromEveEvent("step.completed", "running")).toBe("running");
    expect(scheduleExecutionStatusFromEveEvent(undefined, "running")).toBe("running");
    // Every declared boundary event resolves to a non-running outcome once a
    // question is pending, and all but `turn.waiting` without one.
    // v27 settled events carry their outcome in `data`.
    const sample = (type: string) =>
      type === "turn.settled" || type === "session.ended" ? { outcome: "completed" } : undefined;
    for (const type of EVE_SESSION_BOUNDARY_EVENT_TYPES) {
      expect(scheduleExecutionStatusFromEveEvent(type, "waiting_approval", sample(type))).not.toBe(
        "running",
      );
      if (type !== "turn.waiting") {
        expect(scheduleExecutionStatusFromEveEvent(type, "running", sample(type))).not.toBe(
          "running",
        );
      }
    }
  });

  test("maps v27 settled outcomes onto the scheduled-execution outcome", () => {
    const { scheduleExecutionStatusFromEveEvent } = Eve;
    const settled = (outcome: string) => ({ turnId: "t", outcome });
    expect(
      scheduleExecutionStatusFromEveEvent("turn.settled", "running", settled("completed")),
    ).toBe("succeeded");
    expect(scheduleExecutionStatusFromEveEvent("turn.settled", "running", settled("failed"))).toBe(
      "failed",
    );
    expect(
      scheduleExecutionStatusFromEveEvent("turn.settled", "running", settled("cancelled")),
    ).toBe("failed");
    expect(scheduleExecutionStatusFromEveEvent("session.ended", "running", settled("failed"))).toBe(
      "failed",
    );
    // A v27 turn pauses only for a person.
    expect(scheduleExecutionStatusFromEveEvent("turn.paused", "running")).toBe("parked");
    // An unknown or missing outcome never settles the run.
    expect(scheduleExecutionStatusFromEveEvent("turn.settled", "running")).toBe("running");
    expect(scheduleExecutionStatusFromEveEvent("turn.settled", "running", settled("later"))).toBe(
      "running",
    );
    expect(scheduleExecutionStatusFromEveEvent("model.settled", "running")).toBe("running");
  });

  test("projects v27 session status from interactions and settled outcomes", () => {
    const { sessionStatusFromEveEvent } = Eve;
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
    // 0.69 resumes an answered turn under the same turnId, with no turn.started.
    expect(sessionStatusFromEveEvent("input.resolved", "waiting_approval")).toBe("running");
    expect(sessionStatusFromEveEvent("input.resolved", "waiting")).toBeNull();
    expect(sessionStatusFromEveEvent("turn.waiting", "waiting_approval")).toBeNull();
    expect(sessionStatusFromEveEvent("turn.waiting", "running")).toBeNull();
    // A connection sign-in waits on a person like an approval does; eve 0.70
    // holds the turn for it, so `authorization.completed` resumes the session.
    expect(sessionStatusFromEveEvent("authorization.required", "running")).toBe("waiting_approval");
    expect(sessionStatusFromEveEvent("authorization.completed", "waiting_approval")).toBe(
      "running",
    );
    expect(sessionStatusFromEveEvent("authorization.completed", "waiting")).toBeNull();
  });

  test("keeps a session parked while a held turn still waits on a person", () => {
    const { sessionStatusFromEveEvent, scheduleExecutionStatusFromEveEvent } = Eve;
    // Answering one of several pending requests resolves it, then eve parks
    // the same turn again with `turn.waiting { on: "input" }` (0.70 for
    // approvals, 0.70.3 for questions); the session still waits on a person.
    let status = sessionStatusFromEveEvent("input.requested", "running")!;
    status = sessionStatusFromEveEvent("input.requested", status)!;
    status = sessionStatusFromEveEvent("input.resolved", status)!;
    expect(status).toBe("running");
    status = sessionStatusFromEveEvent("turn.waiting", status, { on: "input", turnId: "t" })!;
    expect(status).toBe("waiting_approval");
    expect(scheduleExecutionStatusFromEveEvent("turn.waiting", status)).toBe("parked");
    // A turn that waits on its own tasks keeps running, and an event without
    // its payload projects nothing.
    expect(sessionStatusFromEveEvent("turn.waiting", "running", { on: "tasks" })).toBeNull();
    expect(sessionStatusFromEveEvent("turn.waiting", "running")).toBeNull();
  });

  test("renders the Session failure line from the boundary payload", () => {
    const { sessionErrorFromEveEvent } = Eve;
    expect(sessionErrorFromEveEvent("session.failed", { message: "boom" })).toBe("boom");
    expect(
      sessionErrorFromEveEvent("session.ended", {
        outcome: "failed",
        error: { code: "MODEL_CALL_FAILED", message: "v27 boom" },
      }),
    ).toBe("v27 boom");
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
    expect(
      scheduleExecutionErrorFromEveEvent("turn.settled", {
        outcome: "failed",
        error: { code: "X", message: "v27 boom" },
      }),
    ).toBe("Scheduled Session turn.settled (failed): v27 boom");
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
