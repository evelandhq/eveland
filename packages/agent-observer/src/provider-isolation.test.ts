import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, test } from "vitest";
import { createPrivateAgentTelemetryRuntime } from "./runtime.js";

afterEach(() => {
  trace.disable();
  logs.disable();
  metrics.disable();
});

describe("Eveland private telemetry providers", () => {
  test("do not register globally or export any signal through user providers", async () => {
    const userExporter = new InMemorySpanExporter();
    const userProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(userExporter)],
    });
    const userLogExporter = new InMemoryLogRecordExporter();
    const userLoggerProvider = new LoggerProvider({
      processors: [
        new SimpleLogRecordProcessor({
          exporter: userLogExporter,
        }),
      ],
    });
    const userMetricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const userMeterProvider = new MeterProvider({
      readers: [
        new PeriodicExportingMetricReader({
          exporter: userMetricExporter,
        }),
      ],
    });
    const evelandExporter = new InMemorySpanExporter();
    const evelandLogExporter = new InMemoryLogRecordExporter();
    const evelandMetricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);

    expect(trace.setGlobalTracerProvider(userProvider)).toBe(true);
    expect(logs.setGlobalLoggerProvider(userLoggerProvider)).toBe(userLoggerProvider);
    expect(metrics.setGlobalMeterProvider(userMeterProvider)).toBe(true);
    const evelandRuntime = createPrivateAgentTelemetryRuntime({
      policy: {
        schemaVersion: 1,
        revision: 1,
        capture: {
          enabled: true,
          sampleRatio: 1,
          recordInputs: false,
          recordOutputs: false,
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
      },
      exporters: {
        traces: evelandExporter,
        logs: evelandLogExporter,
        metrics: evelandMetricExporter,
      },
    });

    const userSpan = trace.getTracer("user-instrumentation").startSpan("user-operation");
    logs.getLogger("user-instrumentation").emit({
      eventName: "user.event",
      body: "user log",
    });
    metrics.getMeter("user-instrumentation").createCounter("user.counter").add(1);
    await evelandRuntime.capture(
      {
        type: "turn.started",
        scope: { turnId: "turn_1" },
        data: { turnId: "turn_1", follows: null },
      },
      {
        session: { id: "eve_session_1" },
        agent: { name: "Researcher" },
        channel: { kind: "channel:eve" },
        position: { line: 0, index: 0 },
      },
    );
    await evelandRuntime.capture(
      {
        type: "turn.settled",
        scope: { turnId: "turn_1" },
        data: { turnId: "turn_1", outcome: "completed" },
      },
      {
        session: { id: "eve_session_1" },
        agent: { name: "Researcher" },
        channel: { kind: "channel:eve" },
        position: { line: 1, index: 0 },
      },
    );
    userSpan.end();
    await Promise.all([
      userProvider.forceFlush(),
      userLoggerProvider.forceFlush(),
      userMeterProvider.forceFlush(),
      evelandRuntime.forceFlush(),
    ]);

    expect(userExporter.getFinishedSpans().map((span) => span.name)).toEqual(["user-operation"]);
    expect(userLogExporter.getFinishedLogRecords().map((record) => record.eventName)).toEqual([
      "user.event",
    ]);
    expect(
      userMetricExporter
        .getMetrics()
        .flatMap((metric) => metric.scopeMetrics)
        .flatMap((scope) => scope.metrics)
        .map((metric) => metric.descriptor.name),
    ).toEqual(["user.counter"]);
    expect(evelandExporter.getFinishedSpans().map((span) => span.name)).toEqual([
      "invoke_agent Researcher",
    ]);
    expect(evelandLogExporter.getFinishedLogRecords().map((record) => record.eventName)).toEqual([
      "eve.turn.started",
      "eve.turn.settled",
    ]);
    expect(
      evelandMetricExporter
        .getMetrics()
        .flatMap((metric) => metric.scopeMetrics)
        .flatMap((scope) => scope.metrics)
        .map((metric) => metric.descriptor.name),
    ).toContain("eveland.agent.invocations");

    await Promise.all([
      userProvider.shutdown(),
      userLoggerProvider.shutdown(),
      userMeterProvider.shutdown(),
      evelandRuntime.shutdown(),
    ]);
  });
});
