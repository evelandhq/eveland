import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, test } from "vitest";
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
      { type: "message.received", data: { sequence: 2, turnId: "turn_1", message: "private prompt" } },
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
          actions: [{ kind: "tool-call", callId: "call_1", toolName: "search", input: { q: "otel" } }],
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
          status: "success",
          result: { kind: "tool-result", callId: "call_1", output: "found" },
        },
      },
      context,
    );
    await runtime.capture(
      {
        type: "message.completed",
        data: {
          sequence: 6,
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
          sequence: 7,
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
      { type: "turn.completed", data: { sequence: 8, turnId: "turn_1" } },
      context,
    );
    await runtime.forceFlush();

    const finishedSpans = traces.getFinishedSpans();
    expect(finishedSpans.map((span) => span.name).sort()).toEqual([
      "chat openai/gpt-5",
      "execute_tool search",
      "invoke_agent Researcher",
    ]);
    const turnSpan = finishedSpans.find((span) => span.name === "invoke_agent Researcher");
    const modelSpan = finishedSpans.find((span) => span.name === "chat openai/gpt-5");
    const toolSpan = finishedSpans.find((span) => span.name === "execute_tool search");
    expect(turnSpan?.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "Researcher",
      "gen_ai.conversation.id": "eve_session_1",
      "eveland.eve.turn.id": "turn_1",
      "gen_ai.input.messages": JSON.stringify([
        { content: "private prompt", role: "user" },
      ]),
      "gen_ai.output.messages": JSON.stringify([
        { content: "final answer", role: "assistant" },
      ]),
    });
    expect(modelSpan?.parentSpanContext?.spanId).toBe(turnSpan?.spanContext().spanId);
    expect(toolSpan?.parentSpanContext?.spanId).toBe(turnSpan?.spanContext().spanId);
    expect(modelSpan?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "openai/gpt-5",
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 30,
      "gen_ai.usage.cache_read.input_tokens": 10,
      "gen_ai.usage.cache_creation.input_tokens": 4,
      "eveland.gen_ai.usage.cost_usd": 0.012,
      "gen_ai.output.messages": JSON.stringify([
        { content: "final answer", role: "assistant" },
      ]),
    });
    expect(toolSpan?.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "search",
      "gen_ai.tool.call.id": "call_1",
      "gen_ai.tool.call.arguments": JSON.stringify({ q: "otel" }),
      "gen_ai.tool.call.result": JSON.stringify("found"),
    });
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

    const logRecords = logs.getFinishedLogRecords();
    expect(logRecords.map((record) => record.eventName)).toContain("eve.message.received");
    const messageLog = logRecords.find(
      (record) => record.eventName === "eve.message.received",
    );
    expect(messageLog?.body).toMatchObject({
      data: { message: "private prompt" },
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
          status: "success",
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
    expect(serializedLogs).toContain("inputTokens");
    expect(serializedLogs).toContain("call_1");
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

    expect(traces.getFinishedSpans().map((span) => span.name).sort()).toEqual([
      "execute_tool slow_tool",
      "invoke_agent Researcher",
    ]);
    expect(
      traces
        .getFinishedSpans()
        .find((span) => span.name === "invoke_agent Researcher")?.attributes,
    ).toMatchObject({ "eveland.turn.cancelled": true });
  });
});

function policy(
  capture: Partial<RuntimeAgentPolicy["capture"]> = {},
): RuntimeAgentPolicy {
  return {
    schemaVersion: 1,
    revision: 1,
    capture: {
      enabled: true,
      sampleRatio: 1,
      recordInputs: false,
      recordOutputs: false,
      includeReasoning: false,
      ...capture,
    },
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
