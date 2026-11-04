import { SpanStatusCode } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, test } from "vitest";
import { createModelCallCapture, type ModelCallCapture } from "./runtime/model-capture.js";
import {
  createPrivateAgentTelemetryRuntime,
  type AgentTelemetryEvent,
  type PrivateAgentTelemetryRuntime,
  type RuntimeAgentPolicy,
} from "./runtime.js";

const activeRuntimes: PrivateAgentTelemetryRuntime[] = [];

afterEach(async () => {
  await Promise.all(activeRuntimes.splice(0).map((runtime) => runtime.shutdown()));
});

/**
 * One commit line of a v27 stream, as eve 1.0 hands it to a `*` hook: every
 * fact in order, each with the same line and its own index.
 */
type Fact = { type: string; scope?: Record<string, string>; data: Record<string, unknown> };

type HookSession = NonNullable<Parameters<PrivateAgentTelemetryRuntime["capture"]>[1]["session"]>;

function harness(
  capture: Partial<RuntimeAgentPolicy["capture"]> = {},
  modelCapture: ModelCallCapture = createModelCallCapture({}),
  session: HookSession = { id: "eve_v27" },
) {
  const traces = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const runtime = createPrivateAgentTelemetryRuntime({
    policy: policy(capture),
    exporters: { traces, logs, metrics },
    modelCapture,
  });
  activeRuntimes.push(runtime);
  let line = 0;
  async function commit(...facts: Fact[]): Promise<void> {
    for (const [index, fact] of facts.entries()) {
      await runtime.capture(fact as AgentTelemetryEvent, {
        session,
        agent: { name: "Researcher", nodeId: "root" },
        channel: { kind: "channel:eve" },
        position: { line, index },
        now: new Date(Date.UTC(2026, 10, 2, 0, 0, line)),
      });
    }
    line += 1;
  }
  return { runtime, traces, logs, metrics, commit };
}

const turn = { turnId: "turn_1" };

async function runOneTurn(commit: (...facts: Fact[]) => Promise<void>): Promise<void> {
  await commit({
    type: "session.started",
    data: { runtime: { agentId: "a", eveVersion: "1.0.0-rc.1" } },
  });
  await commit(
    {
      type: "delivery.consumed",
      scope: turn,
      data: {
        deliveryId: "dlv_1",
        turnId: "turn_1",
        parts: [{ kind: "text", text: "Find the secret" }],
      },
    },
    {
      type: "turn.started",
      scope: turn,
      data: { turnId: "turn_1", cause: { deliveryId: "dlv_1" }, follows: null },
    },
  );
  await commit(
    { type: "model.requested", scope: turn, data: { runId: "run_1", owner: { turnId: "turn_1" } } },
    {
      type: "model.started",
      scope: { ...turn, runId: "run_1" },
      data: { runId: "run_1", modelId: "anthropic/claude-sonnet-5", attempt: 1 },
    },
  );
  await commit(
    {
      type: "call.requested",
      scope: { ...turn, runId: "run_1" },
      data: {
        callId: "call_1",
        owner: { runId: "run_1" },
        capability: { kind: "tool", name: "search" },
        input: { query: "private input" },
      },
    },
    {
      type: "model.settled",
      scope: { ...turn, runId: "run_1" },
      data: { runId: "run_1", outcome: "completed", finishReason: "tool-calls" },
    },
    {
      type: "usage.recorded",
      scope: { ...turn, runId: "run_1" },
      data: {
        kind: "model",
        owner: { runId: "run_1" },
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 80,
          cacheWriteTokens: 0,
          costUsd: 0.002,
        },
      },
    },
  );
  await commit(
    { type: "call.started", scope: turn, data: { callId: "call_1" } },
    {
      type: "call.settled",
      scope: turn,
      data: { callId: "call_1", outcome: "completed", output: { hits: ["private output"] } },
    },
  );
  await commit({
    type: "model.started",
    scope: { ...turn, runId: "run_2" },
    data: { runId: "run_2", modelId: "anthropic/claude-sonnet-5", attempt: 1 },
  });
  await commit(
    {
      type: "content.completed",
      scope: { ...turn, runId: "run_2" },
      data: { partId: "p1", runId: "run_2", kind: "text", phase: "reply", value: "The answer" },
    },
    {
      type: "model.settled",
      scope: { ...turn, runId: "run_2" },
      data: { runId: "run_2", outcome: "completed", finishReason: "stop" },
    },
    {
      type: "turn.settled",
      scope: turn,
      data: { turnId: "turn_1", outcome: "completed", reply: ["p1"] },
    },
  );
}

describe("private Agent telemetry runtime", () => {
  test.each([
    { id: "eve_root", parent: undefined },
    { id: "eve_child", parent: { sessionId: "eve_root", rootSessionId: "eve_root" } },
    { id: "eve_grandchild", parent: { sessionId: "eve_child", rootSessionId: "eve_root" } },
  ])(
    "exports root lineage on every span and log for $id without parent events",
    async (session) => {
      const { runtime, traces, logs, commit } = harness({}, createModelCallCapture({}), session);
      await runOneTurn(commit);
      await runtime.forceFlush();

      const records = [...traces.getFinishedSpans(), ...logs.getFinishedLogRecords()];
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        expect(record.attributes).toMatchObject({
          "session.id": session.id,
          "gen_ai.conversation.id": session.id,
          "eveland.eve.session.id": session.id,
          "eveland.eve.root_session.id": "eve_root",
        });
      }
    },
  );

  test("becomes a no-op when capture is disabled", async () => {
    const { runtime, traces, logs, metrics, commit } = harness({ enabled: false });
    await runOneTurn(commit);
    await runtime.forceFlush();

    expect(traces.getFinishedSpans()).toEqual([]);
    expect(logs.getFinishedLogRecords()).toEqual([]);
    expect(metrics.getMetrics()).toEqual([]);
  });

  test("maps v27 turn, model run, usage, and call lifecycles to the same span tree", async () => {
    const { runtime, traces, metrics, commit } = harness({
      recordInputs: true,
      recordOutputs: true,
    });
    await runOneTurn(commit);
    await runtime.forceFlush();

    const spans = traces.getFinishedSpans();
    expect(spans.map((span) => span.name).sort()).toEqual([
      "chat anthropic/claude-sonnet-5",
      "chat anthropic/claude-sonnet-5",
      "execute_tool search",
      "invoke_agent Researcher",
    ]);
    const turnSpan = spans.find((span) => span.name === "invoke_agent Researcher")!;
    const [firstRun, secondRun] = spans
      .filter((span) => span.name.startsWith("chat "))
      .sort((left, right) =>
        String(left.attributes["eveland.eve.run.id"]).localeCompare(
          String(right.attributes["eveland.eve.run.id"]),
        ),
      );
    const tool = spans.find((span) => span.name === "execute_tool search")!;
    expect(firstRun!.parentSpanContext?.spanId).toBe(turnSpan.spanContext().spanId);
    expect(tool.parentSpanContext?.spanId).toBe(firstRun!.spanContext().spanId);
    // Usage lands on the run it belongs to even though it arrives after the
    // run settled.
    expect(firstRun!.attributes).toMatchObject({
      "gen_ai.request.model": "anthropic/claude-sonnet-5",
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 30,
      "gen_ai.usage.cache_read.input_tokens": 80,
      "eveland.gen_ai.usage.cost_usd": 0.002,
    });
    expect(secondRun!.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(tool.attributes).toMatchObject({
      "gen_ai.tool.call.id": "call_1",
      "gen_ai.tool.call.arguments": JSON.stringify({ query: "private input" }),
      "eveland.eve.call.outcome": "completed",
    });
    expect(String(turnSpan.attributes["gen_ai.output.messages"])).toContain("The answer");
    expect(String(turnSpan.attributes["gen_ai.input.messages"])).toContain("Find the secret");

    const exported = metrics
      .getMetrics()
      .flatMap((resource) =>
        resource.scopeMetrics.flatMap((scope) =>
          scope.metrics.map((metric) => metric.descriptor.name),
        ),
      );
    expect(exported).toEqual(
      expect.arrayContaining(["gen_ai.client.token.usage", "eveland.agent.tool.calls"]),
    );
  });

  test("keeps inputs and outputs out of v27 logs and spans unless the policy records them", async () => {
    const { runtime, traces, logs, commit } = harness();
    await runOneTurn(commit);
    await runtime.forceFlush();

    const serialized = JSON.stringify({
      logs: logs
        .getFinishedLogRecords()
        .map((record) => ({ body: record.body, attributes: record.attributes })),
      spans: traces.getFinishedSpans().map((span) => span.attributes),
    });
    for (const secret of ["Find the secret", "private input", "private output", "The answer"]) {
      expect(serialized).not.toContain(secret);
    }
    // The usage itself is never redacted: it is what the platform bills.
    const usage = logs
      .getFinishedLogRecords()
      .find((record) => record.attributes["eveland.eve.event.type"] === "usage.recorded");
    expect(usage?.body).toMatchObject({
      type: "usage.recorded",
      data: { owner: { runId: "run_1" }, usage: { inputTokens: 120 } },
    });
  });

  test("stamps v27 logs with the stream position, record time, and a position fingerprint", async () => {
    const { runtime, logs, commit } = harness();
    await runOneTurn(commit);
    await runtime.forceFlush();

    const records = logs.getFinishedLogRecords();
    const turnSettled = records.find(
      (record) => record.attributes["eveland.eve.event.type"] === "turn.settled",
    )!;
    expect(turnSettled.attributes).toMatchObject({
      "eveland.eve.turn.id": "turn_1",
      "eveland.eve.position.line": 6,
      "eveland.eve.position.index": 2,
      "eveland.eve.channel.kind": "channel:eve",
    });
    expect(turnSettled.body).toMatchObject({
      type: "turn.settled",
      scope: { turnId: "turn_1" },
      meta: { at: "2026-11-02T00:00:06.000Z", position: { line: 6, index: 2 } },
    });
    expect(turnSettled.hrTime[0]).toBe(Date.UTC(2026, 10, 2, 0, 0, 6) / 1000);
    expect(
      records.find((record) => record.attributes["eveland.eve.event.type"] === "usage.recorded")
        ?.attributes["eveland.eve.run.id"],
    ).toBe("run_1");
    const fingerprints = records.map((record) => record.attributes["eveland.event.fingerprint"]);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  test("records failed v27 turns and sessions from their outcome", async () => {
    const { runtime, traces, logs, commit } = harness();
    await commit({ type: "turn.started", scope: turn, data: { turnId: "turn_1", follows: null } });
    await commit({
      type: "turn.settled",
      scope: turn,
      data: {
        turnId: "turn_1",
        outcome: "failed",
        error: { code: "MODEL_CALL_FAILED", message: "boom" },
      },
    });
    await commit({
      type: "session.ended",
      data: { outcome: "failed", error: { code: "X", message: "session boom" } },
    });
    await runtime.forceFlush();

    const turnSpan = traces
      .getFinishedSpans()
      .find((span) => span.name === "invoke_agent Researcher");
    expect(turnSpan?.status).toEqual({ code: SpanStatusCode.ERROR, message: "boom" });
    const severities = Object.fromEntries(
      logs
        .getFinishedLogRecords()
        .map((record) => [record.attributes["eveland.eve.event.type"], record.severityText]),
    );
    expect(severities).toMatchObject({
      "turn.settled": "ERROR",
      "session.ended": "ERROR",
      "turn.started": "INFO",
    });
  });

  test("collects v27 reasoning only when outputs are recorded and skips progress records", async () => {
    const reasoning: Fact = {
      type: "content.completed",
      scope: { ...turn, runId: "run_1" },
      data: {
        partId: "r1",
        runId: "run_1",
        kind: "reasoning",
        phase: "narration",
        value: "thinking",
      },
    };
    const progress: Fact = { type: "content.delta", data: { partId: "p", delta: "x" } };
    for (const recordOutputs of [false, true]) {
      const { runtime, logs, commit } = harness({ recordOutputs });
      await commit(reasoning, progress);
      await runtime.forceFlush();
      expect(
        logs.getFinishedLogRecords().map((record) => record.attributes["eveland.eve.event.type"]),
      ).toEqual(recordOutputs ? ["content.completed"] : []);
    }
  });

  test("keeps content its turn wrote without a model run, and a turn-owned call, under the turn", async () => {
    // eve 1.0.0-rc.2 lets a turn write content (no `runId`) and own a call
    // (`owner: { turnId }`) without a model run.
    const { runtime, traces, commit } = harness({ recordInputs: true, recordOutputs: true });
    await commit(
      {
        type: "delivery.consumed",
        scope: turn,
        data: { deliveryId: "dlv_1", turnId: "turn_1", parts: [{ kind: "text", text: "Hi" }] },
      },
      {
        type: "turn.started",
        scope: turn,
        data: { turnId: "turn_1", cause: { deliveryId: "dlv_1" }, follows: null },
      },
      {
        type: "content.completed",
        scope: turn,
        data: { partId: "t1", kind: "text", phase: "narration", value: "Turn-written note" },
      },
      {
        type: "call.requested",
        scope: turn,
        data: {
          callId: "call_turn",
          owner: { turnId: "turn_1" },
          capability: { kind: "tool", name: "lookup" },
          input: {},
        },
      },
      {
        type: "call.settled",
        scope: turn,
        data: { callId: "call_turn", outcome: "completed", output: {} },
      },
    );
    await commit({
      type: "model.started",
      scope: { ...turn, runId: "run_1" },
      data: { runId: "run_1", modelId: "anthropic/claude-sonnet-5", attempt: 1 },
    });
    await commit(
      {
        type: "model.settled",
        scope: { ...turn, runId: "run_1" },
        data: { runId: "run_1", outcome: "completed", finishReason: "stop" },
      },
      { type: "turn.settled", scope: turn, data: { turnId: "turn_1", outcome: "completed" } },
    );
    await runtime.forceFlush();

    const spans = traces.getFinishedSpans();
    const turnSpan = spans.find((span) => span.name.startsWith("invoke_agent Researcher"));
    const tool = spans.find((span) => span.name === "execute_tool lookup");
    expect(tool?.parentSpanContext?.spanId).toBe(turnSpan?.spanContext().spanId);
    const run = spans.find((span) => span.attributes["gen_ai.operation.name"] === "chat");
    expect(String(run?.attributes["gen_ai.input.messages"])).toContain("Turn-written note");
  });

  test("carries the observed per-call model into the v27 usage log, not only the span", async () => {
    // The configured model and the model the provider actually ran differ, so
    // the Built-in projection must learn the real one from the usage log.
    const taken: unknown[] = [];
    const { runtime, traces, logs, commit } = harness(
      {},
      {
        install() {},
        take(step) {
          taken.push(step);
          return { modelId: "actual/model", responseModelId: "actual/model-2026-11-01" };
        },
      },
    );
    const scope = { turnId: "t", runId: "r" };
    await commit({ type: "turn.started", scope: { turnId: "t" }, data: { turnId: "t" } });
    await commit({
      type: "model.started",
      scope,
      data: { runId: "r", modelId: "manifest/model" },
    });
    await commit({
      type: "model.settled",
      scope,
      data: { runId: "r", outcome: "completed", finishReason: "stop" },
    });
    await commit({
      type: "usage.recorded",
      scope,
      data: { kind: "model", owner: { runId: "r" }, usage: { inputTokens: 10, outputTokens: 5 } },
    });
    await runtime.forceFlush();

    expect(taken).toHaveLength(1);
    expect(traces.getFinishedSpans().map((span) => span.name)).toContain("chat actual/model");
    const usage = logs
      .getFinishedLogRecords()
      .find((record) => record.attributes["eveland.eve.event.type"] === "usage.recorded");
    expect(usage, "the usage.recorded log was emitted").toBeDefined();
    expect(usage?.attributes["eveland.gen_ai.observed.model"]).toBe("actual/model");
    expect(usage?.attributes["eveland.gen_ai.observed.response_model"]).toBe(
      "actual/model-2026-11-01",
    );
  });

  test("never lets a malformed v27 event escape the capture", async () => {
    const { runtime, commit } = harness();
    await expect(
      commit(
        { type: "usage.recorded", data: { owner: "not a record", usage: null } },
        { type: "call.settled", data: { callId: 7 } },
        { type: "turn.settled", data: {} },
        { type: "session.ended", data: { outcome: 42 } },
      ),
    ).resolves.toBeUndefined();
    await runtime.forceFlush();
  });
});

function policy(capture: Partial<RuntimeAgentPolicy["capture"]> = {}): RuntimeAgentPolicy {
  return {
    schemaVersion: 1,
    revision: 1,
    capture: {
      enabled: true,
      sampleRatio: 1,
      recordInputs: false,
      recordOutputs: false,
      ...capture,
    },
    deploymentCredential: "credential.signature",
    otlp: { endpoint: "http://127.0.0.1:4318" },
    resource: {
      teamId: "team_1",
      projectId: "proj_1",
      releaseId: "rel_1",
      deploymentId: "dep_1",
      runtimeKind: "systemd",
      environment: "production",
    },
  };
}
