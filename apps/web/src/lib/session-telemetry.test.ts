import { describe, expect, test } from "vitest";
import type {
  BuiltInOtlpLogRecord,
  BuiltInOtlpSpan,
  SessionOtlpTelemetry,
} from "@eveland/core/observability";
import { buildSessionTraceRows } from "./session-telemetry";

describe("Session trace tree", () => {
  test("orders children under parents and attaches logs by span context", () => {
    const child = span({
      spanId: "span_child",
      parentSpanId: "span_root",
      name: "chat openai/gpt-5",
      startedAt: "2026-07-23T12:00:00.050Z",
    });
    const root = span({
      spanId: "span_root",
      parentSpanId: null,
      name: "invoke_agent Researcher",
      startedAt: "2026-07-23T12:00:00.000Z",
    });
    const correlated = logRecord({
      id: "log_correlated",
      spanId: "span_child",
      body: "Model completed.",
    });
    const uncorrelated = logRecord({
      id: "log_session",
      spanId: null,
      body: "Session completed.",
    });

    const result = buildSessionTraceRows(
      telemetry([child, root], [uncorrelated, correlated]),
    );

    expect(result.rows.map((row) => [row.span.name, row.depth])).toEqual([
      ["invoke_agent Researcher", 0],
      ["chat openai/gpt-5", 1],
    ]);
    expect(result.rows[1]?.logs).toEqual([correlated]);
    expect(result.uncorrelatedLogs).toEqual([uncorrelated]);
  });

  test("keeps orphaned and cyclic spans visible", () => {
    const orphan = span({
      spanId: "span_orphan",
      parentSpanId: "span_missing",
      name: "execute_tool search",
      startedAt: "2026-07-23T12:00:00.000Z",
    });
    const first = span({
      spanId: "span_cycle_1",
      parentSpanId: "span_cycle_2",
      name: "cycle one",
      startedAt: "2026-07-23T12:00:01.000Z",
    });
    const second = span({
      spanId: "span_cycle_2",
      parentSpanId: "span_cycle_1",
      name: "cycle two",
      startedAt: "2026-07-23T12:00:02.000Z",
    });

    const result = buildSessionTraceRows(
      telemetry([second, orphan, first], []),
    );

    expect(result.rows.map((row) => row.span.spanId).sort()).toEqual([
      "span_cycle_1",
      "span_cycle_2",
      "span_orphan",
    ]);
  });
});

function telemetry(
  spans: BuiltInOtlpSpan[],
  logs: BuiltInOtlpLogRecord[],
): SessionOtlpTelemetry {
  return {
    sessionId: "session_1",
    eveSessionIds: ["eve_session_1"],
    traceIds: ["trace_1"],
    spans,
    logs,
  };
}

function span(input: {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startedAt: string;
}): BuiltInOtlpSpan {
  return {
    id: `stored_${input.spanId}`,
    traceId: "trace_1",
    spanId: input.spanId,
    parentSpanId: input.parentSpanId,
    name: input.name,
    kind: 1,
    startedAt: input.startedAt,
    endedAt: "2026-07-23T12:00:03.000Z",
    durationMs: 100,
    statusCode: 1,
    statusMessage: null,
    scopeName: "test",
    attributes: {},
    resource: {
      serviceName: "eveland-agent",
      domain: "agent",
      projectId: "proj_1",
      deploymentId: null,
      attributes: {},
    },
    payload: {},
    receivedAt: "2026-07-23T12:00:04.000Z",
  };
}

function logRecord(input: {
  id: string;
  spanId: string | null;
  body: string;
}): BuiltInOtlpLogRecord {
  return {
    id: input.id,
    traceId: "trace_1",
    spanId: input.spanId,
    timestamp: "2026-07-23T12:00:02.000Z",
    observedTimestamp: null,
    severityNumber: 9,
    severityText: "INFO",
    eventName: "eve.test",
    scopeName: "test",
    body: input.body,
    attributes: {},
    resource: {
      serviceName: "eveland-agent",
      domain: "agent",
      projectId: "proj_1",
      deploymentId: null,
      attributes: {},
    },
    payload: {},
    receivedAt: "2026-07-23T12:00:04.000Z",
  };
}
