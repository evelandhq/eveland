import { SpanStatusCode } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import type { InputRequestedStreamEvent } from "eve/client";
import { afterEach, describe, expect, test } from "vitest";
import { createModelCallCapture } from "./runtime/model-capture.js";
import {
  createPrivateAgentTelemetryRuntime,
  type PrivateAgentTelemetryRuntime,
  type RuntimeAgentPolicy,
} from "./runtime.js";

const activeRuntimes: PrivateAgentTelemetryRuntime[] = [];

afterEach(async () => {
  await Promise.all(activeRuntimes.splice(0).map((runtime) => runtime.shutdown()));
});

describe("private Agent telemetry runtime", () => {
  test("maps Eve turn, model, and tool lifecycles to private OTel signals", async () => {
    const traces = new InMemorySpanExporter();
    const logs = new InMemoryLogRecordExporter();
    const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const runtime = createPrivateAgentTelemetryRuntime({
      policy: policy({
        recordInputs: true,
        recordOutputs: true,
      }),
      exporters: { traces, logs, metrics },
      runtimeInstanceId: "rti_1",
    });
    activeRuntimes.push(runtime);
    const context = hookContext();

    await runtime.capture(
      {
        type: "session.started",
        data: {
          runtime: {
            agentId: "root",
            agentName: "Researcher",
            eveVersion: "0.27.0",
            modelId: "openai/gpt-5",
          },
        },
      },
      context,
    );
    await runtime.capture(
      { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
      context,
    );
    await runtime.capture(
      {
        type: "message.received",
        data: { sequence: 2, turnId: "turn_1", message: "private prompt" },
      },
      context,
    );
    await runtime.capture(
      { type: "step.started", data: { sequence: 3, turnId: "turn_1", stepIndex: 0 } },
      context,
    );
    await runtime.capture(
      {
        type: "actions.requested",
        data: {
          sequence: 4,
          turnId: "turn_1",
          stepIndex: 0,
          actions: [
            { kind: "tool-call", callId: "call_1", toolName: "search", input: { q: "otel" } },
            {
              kind: "tool-call",
              callId: "call_2",
              toolName: "fetch",
              input: { url: "https://example.com" },
            },
          ],
        },
      },
      context,
    );
    await runtime.capture(
      {
        type: "action.result",
        data: {
          sequence: 5,
          turnId: "turn_1",
          stepIndex: 0,
          status: "completed",
          result: { kind: "tool-result", callId: "call_1", output: "found" },
        },
      },
      context,
    );
    await runtime.capture(
      {
        type: "action.result",
        data: {
          sequence: 6,
          turnId: "turn_1",
          stepIndex: 0,
          status: "failed",
          error: { code: "tool_error", message: "fetch exploded" },
          result: { kind: "tool-result", callId: "call_2", output: "boom", isError: true },
        },
      },
      context,
    );
    await runtime.capture(
      {
        type: "message.completed",
        data: {
          sequence: 7,
          turnId: "turn_1",
          stepIndex: 0,
          finishReason: "stop",
          message: "final answer",
        },
      },
      context,
    );
    await runtime.capture(
      {
        type: "step.completed",
        data: {
          sequence: 8,
          turnId: "turn_1",
          stepIndex: 0,
          finishReason: "stop",
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            cacheReadTokens: 10,
            cacheWriteTokens: 4,
            costUsd: 0.012,
          },
        },
      },
      context,
    );
    await runtime.capture(
      { type: "turn.completed", data: { sequence: 9, turnId: "turn_1" } },
      context,
    );
    await runtime.forceFlush();

    const finishedSpans = traces.getFinishedSpans();
    expect(finishedSpans.map((span) => span.name).sort()).toEqual([
      "chat openai/gpt-5",
      "execute_tool fetch",
      "execute_tool search",
      "invoke_agent Researcher",
    ]);
    const turnSpan = finishedSpans.find((span) => span.name === "invoke_agent Researcher");
    const modelSpan = finishedSpans.find((span) => span.name === "chat openai/gpt-5");
    const toolSpan = finishedSpans.find((span) => span.name === "execute_tool search");
    const failedToolSpan = finishedSpans.find((span) => span.name === "execute_tool fetch");
    expect(turnSpan?.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "Researcher",
      "gen_ai.conversation.id": "eve_session_1",
      "eveland.eve.turn.id": "turn_1",
    });
    expect(JSON.parse(String(turnSpan?.attributes["gen_ai.input.messages"]))).toEqual([
      { parts: [{ content: "private prompt", type: "text" }], role: "user" },
    ]);
    expect(JSON.parse(String(turnSpan?.attributes["gen_ai.output.messages"]))).toEqual([
      {
        finish_reason: "stop",
        parts: [{ content: "final answer", type: "text" }],
        role: "assistant",
      },
    ]);
    expect(modelSpan?.parentSpanContext?.spanId).toBe(turnSpan?.spanContext().spanId);
    expect(toolSpan?.parentSpanContext?.spanId).toBe(modelSpan?.spanContext().spanId);
    expect(modelSpan?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "openai/gpt-5",
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 30,
      "gen_ai.usage.cache_read.input_tokens": 10,
      "gen_ai.usage.cache_creation.input_tokens": 4,
      "eveland.gen_ai.usage.cost_usd": 0.012,
      "eveland.gen_ai.input.reconstructed": true,
    });
    expect(JSON.parse(String(modelSpan?.attributes["gen_ai.input.messages"]))).toEqual([
      { parts: [{ content: "private prompt", type: "text" }], role: "user" },
    ]);
    expect(JSON.parse(String(modelSpan?.attributes["gen_ai.output.messages"]))).toEqual([
      {
        finish_reason: "stop",
        parts: [
          { arguments: { q: "otel" }, id: "call_1", name: "search", type: "tool_call" },
          {
            arguments: { url: "https://example.com" },
            id: "call_2",
            name: "fetch",
            type: "tool_call",
          },
          { content: "final answer", type: "text" },
        ],
        role: "assistant",
      },
    ]);
    expect(toolSpan?.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "search",
      "gen_ai.tool.call.id": "call_1",
      "gen_ai.tool.call.arguments": JSON.stringify({ q: "otel" }),
      "gen_ai.tool.call.result": JSON.stringify("found"),
    });
    expect(toolSpan?.status.code).toBe(SpanStatusCode.UNSET);
    expect(failedToolSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(failedToolSpan?.status.message).toBe("fetch exploded");
    expect(turnSpan?.resource.attributes).toMatchObject({
      "service.name": "eveland-agent",
      "deployment.environment.name": "production",
      "eveland.team.id": "team_1",
      "eveland.project.id": "proj_1",
      "eveland.release.id": "rel_1",
      "eveland.deployment.id": "dep_1",
      "eveland.runtime.kind": "systemd",
      "eveland.runtime.instance.id": "rti_1",
      "eveland.telemetry.domain": "agent",
    });
    expect(turnSpan?.resource.attributes).toMatchObject({
      "eveland.deployment.credential": "credential.signature",
    });

    const logRecords = logs.getFinishedLogRecords();
    expect(logRecords.map((record) => record.eventName)).toContain("eve.message.received");
    const messageLog = logRecords.find((record) => record.eventName === "eve.message.received");
    expect(messageLog?.body).toMatchObject({
      data: { message: "private prompt" },
    });
    expect(messageLog?.resource.attributes).toMatchObject({
      "eveland.deployment.id": "dep_1",
      "eveland.deployment.credential": "credential.signature",
    });
    expect(messageLog?.attributes).toMatchObject({
      "eveland.event.id": expect.any(String),
      "eveland.event.fingerprint": expect.any(String),
      "eveland.eve.session.id": "eve_session_1",
      "eveland.eve.turn.id": "turn_1",
      "eveland.eve.agent.name": "Researcher",
    });
    expect(
      logRecords.find((record) => record.eventName === "eve.step.completed")?.spanContext?.spanId,
    ).toBe(modelSpan?.spanContext().spanId);

    const metricData = metrics
      .getMetrics()
      .flatMap((resourceMetric) => resourceMetric.scopeMetrics)
      .flatMap((scopeMetric) => scopeMetric.metrics);
    expect(metrics.getMetrics()[0]?.resource.attributes).toMatchObject({
      "eveland.deployment.credential": "credential.signature",
    });
    const tokenMetric = metricData.find(
      (metric) => metric.descriptor.name === "gen_ai.client.token.usage",
    );
    expect(metricData.map((metric) => metric.descriptor.name)).toEqual(
      expect.arrayContaining([
        "gen_ai.client.operation.duration",
        "gen_ai.client.token.usage",
        "eveland.agent.invocations",
        "eveland.agent.tool.calls",
      ]),
    );
    expect(
      tokenMetric?.dataPoints.map((point) => ({
        attributes: point.attributes,
        value: "sum" in Object(point.value) ? Object(point.value).sum : point.value,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          attributes: expect.objectContaining({
            "gen_ai.request.model": "openai/gpt-5",
            "gen_ai.token.type": "input",
          }),
          value: 120,
        },
        {
          attributes: expect.objectContaining({
            "gen_ai.request.model": "openai/gpt-5",
            "gen_ai.token.type": "output",
          }),
          value: 30,
        },
      ]),
    );
  });

  test("removes inputs, outputs, reasoning, and credentials before creating LogRecords", async () => {
    const traces = new InMemorySpanExporter();
    const logs = new InMemoryLogRecordExporter();
    const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const runtime = createPrivateAgentTelemetryRuntime({
      policy: policy(),
      exporters: { traces, logs, metrics },
    });
    activeRuntimes.push(runtime);
    const context = hookContext();

    await runtime.capture(
      {
        type: "message.received",
        data: {
          turnId: "turn_1",
          message: "do not export",
          parts: [{ type: "text", text: "also private" }],
          apiKey: "secret-key",
          inputTokens: 17,
        },
      },
      context,
    );
    await runtime.capture(
      {
        type: "action.result",
        data: {
          turnId: "turn_1",
          status: "completed",
          result: { callId: "call_1", output: "do not export", continuationToken: "secret-token" },
        },
      },
      context,
    );
    await runtime.capture(
      {
        type: "reasoning.completed",
        data: { turnId: "turn_1", stepIndex: 0, reasoning: "private chain of thought" },
      },
      context,
    );
    const inputRequestedEvent = {
      type: "input.requested",
      data: {
        sequence: 3,
        turnId: "turn_1",
        stepIndex: 0,
        requests: [
          {
            requestId: "request_1",
            kind: "tool-approval",
            prompt: "Approve the private deployment?",
            display: "confirmation",
            options: [
              { id: "approve", label: "Approve private deployment" },
              { id: "deny", label: "Deny private deployment" },
            ],
            action: {
              kind: "tool-call",
              callId: "call_private",
              toolName: "deploy",
              input: { environment: "private-production" },
            },
          },
        ],
      },
    } satisfies InputRequestedStreamEvent;
    await runtime.capture(inputRequestedEvent, context);
    await runtime.forceFlush();

    const serializedLogs = JSON.stringify(
      logs.getFinishedLogRecords().map((record) => ({
        eventName: record.eventName,
        body: record.body,
      })),
    );
    expect(serializedLogs).not.toContain("do not export");
    expect(serializedLogs).not.toContain("also private");
    expect(serializedLogs).not.toContain("secret-key");
    expect(serializedLogs).not.toContain("secret-token");
    expect(serializedLogs).not.toContain("private chain of thought");
    expect(serializedLogs).not.toContain("Approve the private deployment?");
    expect(serializedLogs).not.toContain("Approve private deployment");
    expect(serializedLogs).not.toContain("private-production");
    expect(serializedLogs).toContain("inputTokens");
    expect(serializedLogs).toContain("call_1");
    expect(logs.getFinishedLogRecords().map((record) => record.eventName)).toContain(
      "eve.input.requested",
    );
    expect(logs.getFinishedLogRecords().map((record) => record.eventName)).not.toContain(
      "eve.reasoning.completed",
    );
  });

  test("keeps missing usage missing and becomes a no-op when capture is disabled", async () => {
    const traces = new InMemorySpanExporter();
    const logs = new InMemoryLogRecordExporter();
    const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const runtime = createPrivateAgentTelemetryRuntime({
      policy: policy({ enabled: false }),
      exporters: { traces, logs, metrics },
    });
    activeRuntimes.push(runtime);

    await expect(
      runtime.capture(
        {
          type: "step.completed",
          data: { turnId: "turn_1", stepIndex: 0, finishReason: "stop" },
        },
        hookContext(),
      ),
    ).resolves.toBeUndefined();
    await runtime.forceFlush();

    expect(traces.getFinishedSpans()).toEqual([]);
    expect(logs.getFinishedLogRecords()).toEqual([]);
    expect(metrics.getMetrics()).toEqual([]);
  });

  test("names the model span from step.started when the session identity carries no model", async () => {
    // Eve <=0.32 reported the configured model on `session.started`'s runtime
    // identity. Eve 0.33 removed it -- a dynamic-model Agent has no configured
    // model to report -- and moved the id onto `step.started`, where a concrete
    // model has actually been selected. Reading only the old source leaves the
    // span named a bare "chat" with no `gen_ai.request.model`.
    const traces = new InMemorySpanExporter();
    const runtime = createPrivateAgentTelemetryRuntime({
      policy: policy(),
      exporters: {
        traces,
        logs: new InMemoryLogRecordExporter(),
        metrics: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      },
    });
    activeRuntimes.push(runtime);
    const context = hookContext();

    await runtime.capture(
      { type: "session.started", data: { runtime: { agentName: "reporter" } } },
      context,
    );
    await runtime.capture({ type: "turn.started", data: { turnId: "turn_1" } }, context);
    await runtime.capture(
      { type: "step.started", data: { turnId: "turn_1", stepIndex: 0, modelId: "openai/gpt-5" } },
      context,
    );
    await runtime.capture(
      {
        type: "step.completed",
        data: { turnId: "turn_1", stepIndex: 0, finishReason: "stop" },
      },
      context,
    );
    await runtime.capture({ type: "turn.completed", data: { turnId: "turn_1" } }, context);
    await runtime.forceFlush();

    const modelSpan = traces
      .getFinishedSpans()
      .find((span) => span.attributes["gen_ai.operation.name"] === "chat");
    expect(modelSpan?.name).toBe("chat openai/gpt-5");
    expect(modelSpan?.attributes["gen_ai.request.model"]).toBe("openai/gpt-5");
  });

  test("does not synthesize a model, provider, or usage when Eve does not report them", async () => {
    const traces = new InMemorySpanExporter();
    const logs = new InMemoryLogRecordExporter();
    const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const runtime = createPrivateAgentTelemetryRuntime({
      policy: policy(),
      exporters: { traces, logs, metrics },
    });
    activeRuntimes.push(runtime);
    const context = hookContext();

    await runtime.capture(
      { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
      context,
    );
    await runtime.capture(
      { type: "step.started", data: { sequence: 2, turnId: "turn_1", stepIndex: 0 } },
      context,
    );
    await runtime.capture(
      {
        type: "step.completed",
        data: {
          sequence: 3,
          turnId: "turn_1",
          stepIndex: 0,
          finishReason: "stop",
        },
      },
      context,
    );
    await runtime.capture(
      { type: "turn.completed", data: { sequence: 4, turnId: "turn_1" } },
      context,
    );
    await runtime.forceFlush();

    const modelSpan = traces
      .getFinishedSpans()
      .find((span) => span.attributes["gen_ai.operation.name"] === "chat");
    expect(modelSpan?.name).toBe("chat");
    expect(modelSpan?.attributes).not.toHaveProperty("gen_ai.request.model");
    expect(modelSpan?.attributes).not.toHaveProperty("gen_ai.provider.name");
    expect(modelSpan?.attributes).not.toHaveProperty("gen_ai.usage.input_tokens");
    expect(
      metrics
        .getMetrics()
        .flatMap((metric) => metric.scopeMetrics)
        .flatMap((scope) => scope.metrics)
        .map((metric) => metric.descriptor.name),
    ).not.toContain("gen_ai.client.token.usage");
  });

  test("ends open child spans when a turn is cancelled", async () => {
    const traces = new InMemorySpanExporter();
    const logs = new InMemoryLogRecordExporter();
    const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const runtime = createPrivateAgentTelemetryRuntime({
      policy: policy(),
      exporters: { traces, logs, metrics },
    });
    activeRuntimes.push(runtime);
    const context = hookContext();

    await runtime.capture(
      { type: "turn.started", data: { sequence: 1, turnId: "turn_1" } },
      context,
    );
    await runtime.capture(
      {
        type: "actions.requested",
        data: {
          sequence: 2,
          turnId: "turn_1",
          stepIndex: 0,
          actions: [
            {
              kind: "tool-call",
              callId: "call_open",
              toolName: "slow_tool",
              input: {},
            },
          ],
        },
      },
      context,
    );
    await runtime.capture(
      { type: "turn.cancelled", data: { sequence: 3, turnId: "turn_1" } },
      context,
    );
    await runtime.forceFlush();

    expect(
      traces
        .getFinishedSpans()
        .map((span) => span.name)
        .sort(),
    ).toEqual(["execute_tool slow_tool", "invoke_agent Researcher"]);
    expect(
      traces.getFinishedSpans().find((span) => span.name === "invoke_agent Researcher")?.attributes,
    ).toMatchObject({ "eveland.turn.cancelled": true });
  });

  test("gives a tool-only model call reasoning and tool calls as its output", async () => {
    const traces = new InMemorySpanExporter();
    const runtime = createPrivateAgentTelemetryRuntime({
      policy: policy({ recordInputs: true, recordOutputs: true }),
      exporters: {
        traces,
        logs: new InMemoryLogRecordExporter(),
        metrics: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      },
    });
    activeRuntimes.push(runtime);
    const context = hookContext();

    await runtime.capture(
      { type: "session.started", data: { runtime: { modelId: "openai/gpt-5" } } },
      context,
    );
    await runtime.capture({ type: "turn.started", data: { turnId: "turn_1" } }, context);
    await runtime.capture(
      { type: "message.received", data: { turnId: "turn_1", message: "tag the conversations" } },
      context,
    );
    await runtime.capture(
      { type: "step.started", data: { turnId: "turn_1", stepIndex: 0 } },
      context,
    );
    await runtime.capture(
      {
        type: "reasoning.completed",
        data: { turnId: "turn_1", stepIndex: 0, reasoning: "load the skill first" },
      },
      context,
    );
    await runtime.capture(
      {
        type: "actions.requested",
        data: {
          turnId: "turn_1",
          stepIndex: 0,
          actions: [{ kind: "load-skill", callId: "call_1", input: { name: "rubric" } }],
        },
      },
      context,
    );
    await runtime.capture(
      {
        type: "action.result",
        data: {
          turnId: "turn_1",
          stepIndex: 0,
          status: "completed",
          result: { kind: "load-skill-result", callId: "call_1", output: "rubric body" },
        },
      },
      context,
    );
    await runtime.capture(
      {
        type: "step.completed",
        data: { turnId: "turn_1", stepIndex: 0, finishReason: "tool-calls" },
      },
      context,
    );
    await runtime.capture(
      { type: "step.started", data: { turnId: "turn_1", stepIndex: 1 } },
      context,
    );
    await runtime.capture(
      {
        type: "message.completed",
        data: { turnId: "turn_1", stepIndex: 1, finishReason: "stop", message: "tagged 50" },
      },
      context,
    );
    await runtime.capture(
      { type: "step.completed", data: { turnId: "turn_1", stepIndex: 1, finishReason: "stop" } },
      context,
    );
    await runtime.capture({ type: "turn.completed", data: { turnId: "turn_1" } }, context);
    await runtime.forceFlush();

    const modelSpans = traces
      .getFinishedSpans()
      .filter((span) => span.name === "chat openai/gpt-5")
      .sort(
        (left, right) =>
          Number(left.attributes["eveland.eve.step.index"]) -
          Number(right.attributes["eveland.eve.step.index"]),
      );
    expect(modelSpans).toHaveLength(2);

    // The step requested a tool without emitting visible text.
    expect(JSON.parse(String(modelSpans[0]?.attributes["gen_ai.output.messages"]))).toEqual([
      {
        finish_reason: "tool_call",
        parts: [
          { content: "load the skill first", type: "reasoning" },
          { arguments: { name: "rubric" }, id: "call_1", name: "load_skill", type: "tool_call" },
        ],
        role: "assistant",
      },
    ]);

    expect(JSON.parse(String(modelSpans[1]?.attributes["gen_ai.input.messages"]))).toEqual([
      { parts: [{ content: "tag the conversations", type: "text" }], role: "user" },
      {
        parts: [
          { content: "load the skill first", type: "reasoning" },
          { arguments: { name: "rubric" }, id: "call_1", name: "load_skill", type: "tool_call" },
        ],
        role: "assistant",
      },
      {
        name: "load_skill",
        parts: [{ id: "call_1", response: "rubric body", type: "tool_call_response" }],
        role: "tool",
      },
    ]);
  });

  test("replaces the reconstructed history with a compaction part once Eve compacts", async () => {
    const traces = new InMemorySpanExporter();
    const runtime = createPrivateAgentTelemetryRuntime({
      policy: policy({ recordInputs: true, recordOutputs: true }),
      exporters: {
        traces,
        logs: new InMemoryLogRecordExporter(),
        metrics: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      },
    });
    activeRuntimes.push(runtime);
    const context = hookContext();

    await runtime.capture({ type: "turn.started", data: { turnId: "turn_1" } }, context);
    await runtime.capture(
      { type: "message.received", data: { turnId: "turn_1", message: "keep going" } },
      context,
    );
    await runtime.capture(
      {
        type: "compaction.completed",
        data: { turnId: "turn_1", sessionId: "eve_session_1", modelId: "openai/gpt-5" },
      },
      context,
    );
    await runtime.capture(
      { type: "step.started", data: { turnId: "turn_1", stepIndex: 0 } },
      context,
    );
    await runtime.capture(
      { type: "step.completed", data: { turnId: "turn_1", stepIndex: 0, finishReason: "stop" } },
      context,
    );
    await runtime.capture({ type: "turn.completed", data: { turnId: "turn_1" } }, context);
    await runtime.forceFlush();

    const modelSpan = traces.getFinishedSpans().find((span) => span.name === "chat");
    expect(modelSpan?.attributes).toMatchObject({
      "eveland.gen_ai.input.reconstructed": true,
    });
    // The user message Eve folded into the checkpoint is gone, because the model can
    // no longer see it either.
    expect(JSON.parse(String(modelSpan?.attributes["gen_ai.input.messages"]))).toEqual([
      { parts: [{ content: null, type: "compaction" }], role: "system" },
    ]);
  });

  test("records a subagent invocation's input and output as conventions messages", async () => {
    const traces = new InMemorySpanExporter();
    const runtime = createPrivateAgentTelemetryRuntime({
      policy: policy({ recordInputs: true, recordOutputs: true }),
      exporters: {
        traces,
        logs: new InMemoryLogRecordExporter(),
        metrics: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      },
    });
    activeRuntimes.push(runtime);
    const context = hookContext();

    await runtime.capture({ type: "turn.started", data: { turnId: "turn_1" } }, context);
    await runtime.capture(
      { type: "step.started", data: { turnId: "turn_1", stepIndex: 0 } },
      context,
    );
    await runtime.capture(
      {
        type: "actions.requested",
        data: {
          turnId: "turn_1",
          stepIndex: 0,
          actions: [
            {
              kind: "subagent-call",
              callId: "call_sub",
              subagentName: "Summarizer",
              name: "Summarizer",
              nodeId: "root/summarizer",
              description: "summarize",
              input: { text: "long report" },
            },
          ],
        },
      },
      context,
    );
    await runtime.capture(
      {
        type: "action.result",
        data: {
          turnId: "turn_1",
          stepIndex: 0,
          status: "completed",
          result: { kind: "subagent-result", callId: "call_sub", output: "three bullets" },
        },
      },
      context,
    );
    await runtime.capture({ type: "turn.completed", data: { turnId: "turn_1" } }, context);
    await runtime.forceFlush();

    const subagentSpan = traces
      .getFinishedSpans()
      .find((span) => span.name === "invoke_agent Summarizer");
    // `gen_ai.agent.input` / `gen_ai.agent.output` are not registered attributes, so
    // the invocation reports through the conventions' message attributes instead.
    expect(Object.keys(subagentSpan?.attributes ?? {})).not.toContain("gen_ai.agent.input");
    expect(Object.keys(subagentSpan?.attributes ?? {})).not.toContain("gen_ai.agent.output");
    expect(JSON.parse(String(subagentSpan?.attributes["gen_ai.input.messages"]))).toEqual([
      { parts: [{ content: JSON.stringify({ text: "long report" }), type: "text" }], role: "user" },
    ]);
    expect(JSON.parse(String(subagentSpan?.attributes["gen_ai.output.messages"]))).toEqual([
      {
        finish_reason: "stop",
        parts: [{ content: "three bullets", type: "text" }],
        role: "assistant",
      },
    ]);
  });

  test("keeps reasoning out of spans when outputs are not recorded", async () => {
    const traces = new InMemorySpanExporter();
    const runtime = createPrivateAgentTelemetryRuntime({
      policy: policy({ recordInputs: true, recordOutputs: false }),
      exporters: {
        traces,
        logs: new InMemoryLogRecordExporter(),
        metrics: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      },
    });
    activeRuntimes.push(runtime);
    const context = hookContext();

    await runtime.capture({ type: "turn.started", data: { turnId: "turn_1" } }, context);
    await runtime.capture(
      { type: "step.started", data: { turnId: "turn_1", stepIndex: 0 } },
      context,
    );
    await runtime.capture(
      {
        type: "reasoning.completed",
        data: { turnId: "turn_1", stepIndex: 0, reasoning: "private chain of thought" },
      },
      context,
    );
    await runtime.capture(
      { type: "step.completed", data: { turnId: "turn_1", stepIndex: 0, finishReason: "stop" } },
      context,
    );
    await runtime.capture({ type: "turn.completed", data: { turnId: "turn_1" } }, context);
    await runtime.forceFlush();

    expect(JSON.stringify(traces.getFinishedSpans().map((span) => span.attributes))).not.toContain(
      "private chain of thought",
    );
  });

  test("replaces the manifest model with the one the AI SDK actually called", async () => {
    const traces = new InMemorySpanExporter();
    const logs = new InMemoryLogRecordExporter();
    const target: { AI_SDK_TELEMETRY_INTEGRATIONS?: Array<Record<string, unknown>> } = {};
    const modelCapture = createModelCallCapture(target);
    modelCapture.install();
    const runtime = createPrivateAgentTelemetryRuntime({
      policy: policy(),
      exporters: {
        traces,
        logs,
        metrics: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      },
      modelCapture,
    });
    activeRuntimes.push(runtime);
    const context = hookContext();
    const onStepEnd = target.AI_SDK_TELEMETRY_INTEGRATIONS?.[0]?.onStepEnd as (
      event: unknown,
    ) => void;

    await runtime.capture(
      { type: "session.started", data: { runtime: { modelId: "openai/gpt-5" } } },
      context,
    );
    await runtime.capture({ type: "turn.started", data: { turnId: "turn_1" } }, context);
    await runtime.capture(
      { type: "step.started", data: { turnId: "turn_1", stepIndex: 0 } },
      context,
    );
    // The env-derived model diverged from the manifest; the AI SDK reports
    // the call that actually ran before Eve emits step.completed.
    onStepEnd({
      model: { provider: "gateway", modelId: "openai/gpt-6" },
      response: { modelId: "gpt-6-2026-01-01" },
      usage: { inputTokens: 12, outputTokens: 3 },
      finishReason: "tool-calls",
    });
    await runtime.capture(
      {
        type: "step.completed",
        data: {
          turnId: "turn_1",
          stepIndex: 0,
          finishReason: "tool-calls",
          usage: { inputTokens: 12, outputTokens: 3 },
        },
      },
      context,
    );
    await runtime.capture(
      { type: "step.started", data: { turnId: "turn_1", stepIndex: 1 } },
      context,
    );
    await runtime.capture(
      { type: "step.completed", data: { turnId: "turn_1", stepIndex: 1, finishReason: "stop" } },
      context,
    );
    await runtime.capture({ type: "turn.completed", data: { turnId: "turn_1" } }, context);
    await runtime.forceFlush();

    const chatSpans = traces.getFinishedSpans().filter((span) => span.name.startsWith("chat"));
    expect(chatSpans.map((span) => span.name)).toEqual(["chat openai/gpt-6", "chat openai/gpt-6"]);
    expect(chatSpans[0]?.attributes).toMatchObject({
      "gen_ai.request.model": "openai/gpt-6",
      "gen_ai.response.model": "gpt-6-2026-01-01",
    });
    const stepLog = logs
      .getFinishedLogRecords()
      .find((record) => record.attributes["eveland.eve.event.type"] === "step.completed");
    expect(stepLog?.attributes).toMatchObject({
      "eveland.gen_ai.observed.model": "openai/gpt-6",
      "eveland.gen_ai.observed.response_model": "gpt-6-2026-01-01",
    });
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

function hookContext() {
  return {
    session: { id: "eve_session_1" },
    agent: { name: "Researcher", nodeId: "root" },
    channel: { kind: "http" },
  };
}
