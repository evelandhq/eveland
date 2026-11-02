import { SpanStatusCode } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, test } from "vitest";
import { createModelCallCapture } from "./runtime/model-capture.js";
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

function harness(capture: Partial<RuntimeAgentPolicy["capture"]> = {}) {
  const traces = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const runtime = createPrivateAgentTelemetryRuntime({
    policy: policy(capture),
    exporters: { traces, logs, metrics },
    modelCapture: createModelCallCapture({}),
  });
  activeRuntimes.push(runtime);
  let line = 0;
  async function commit(...facts: Fact[]): Promise<void> {
    for (const [index, fact] of facts.entries()) {
      await runtime.capture(fact as AgentTelemetryEvent, {
        session: { id: "eve_v27" },
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

describe("private Agent telemetry runtime on the v27 protocol", () => {
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
