import { describe, expect, test } from "vitest";
import { createTestStore } from "@eveland/db/vitest";
import { createApp } from "./app.js";

describe("Session OTLP telemetry", () => {
  test("returns the Agent span tree and trace-correlated logs for one Session", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Session telemetry",
      importKind: "zip",
    });
    const session = await store.createSession({
      projectId: project.id,
      trigger: "direct_http",
      eveSessionId: "eve_session_1",
    });
    await store.ingestOtlpSpans([
      span({
        projectId: project.id,
        traceId: "trace_1",
        spanId: "span_root",
        parentSpanId: null,
        name: "invoke_agent Researcher",
        eveSessionId: "eve_session_1",
      }),
      span({
        projectId: project.id,
        traceId: "trace_1",
        spanId: "span_model",
        parentSpanId: "span_root",
        name: "chat openai/gpt-5",
        eveSessionId: "eve_session_1",
      }),
      span({
        projectId: project.id,
        traceId: "trace_other",
        spanId: "span_other",
        parentSpanId: null,
        name: "invoke_agent Other",
        eveSessionId: "eve_session_2",
      }),
    ]);
    await store.ingestOtlpLogRecords([
      logRecord({
        projectId: project.id,
        traceId: "trace_1",
        spanId: "span_model",
        domain: "agent",
        eveSessionId: "eve_session_1",
        body: "Model completed.",
      }),
      logRecord({
        projectId: project.id,
        traceId: "trace_1",
        spanId: "span_root",
        domain: "platform",
        eveSessionId: null,
        body: "Gateway request completed.",
      }),
      logRecord({
        projectId: project.id,
        traceId: "trace_other",
        spanId: "span_other",
        domain: "agent",
        eveSessionId: "eve_session_2",
        body: "Other Session.",
      }),
    ]);
    const app = createApp(store);

    const response = await app.request(
      `/sessions/${session.id}/telemetry`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      telemetry: { logs: Array<{ body: unknown }> };
    };
    expect(body).toMatchObject({
      telemetry: {
        sessionId: session.id,
        eveSessionIds: ["eve_session_1"],
        traceIds: ["trace_1"],
        spans: [
          expect.objectContaining({ spanId: "span_model" }),
          expect.objectContaining({ spanId: "span_root" }),
        ],
        logs: expect.arrayContaining([
          expect.objectContaining({ body: "Model completed." }),
          expect.objectContaining({
            body: "Gateway request completed.",
          }),
        ]),
      },
    });
    expect(body.telemetry.logs).toHaveLength(2);
  });

  test("returns not found for an unknown Session", async () => {
    const app = createApp(createTestStore());

    const response = await app.request(
      "/sessions/session_missing/telemetry",
    );

    expect(response.status).toBe(404);
  });
});

function span(input: {
  projectId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  eveSessionId: string;
}) {
  return {
    traceId: input.traceId,
    spanId: input.spanId,
    parentSpanId: input.parentSpanId,
    name: input.name,
    kind: 1,
    startedAt: "2026-07-23T12:00:00.000Z",
    endedAt: "2026-07-23T12:00:00.125Z",
    durationMs: 125,
    statusCode: 1,
    statusMessage: null,
    scopeName: "@eveland/agent-observer",
    attributes: {
      "eveland.eve.session.id": input.eveSessionId,
    },
    resource: {
      serviceName: "eveland-agent",
      domain: "agent" as const,
      projectId: input.projectId,
      deploymentId: null,
      attributes: {},
    },
    payload: {},
  };
}

function logRecord(input: {
  projectId: string;
  traceId: string;
  spanId: string;
  domain: "agent" | "platform";
  eveSessionId: string | null;
  body: string;
}) {
  return {
    traceId: input.traceId,
    spanId: input.spanId,
    timestamp: "2026-07-23T12:00:00.100Z",
    observedTimestamp: null,
    severityNumber: 9,
    severityText: "INFO",
    eventName: "eveland.test.log",
    scopeName: "test",
    body: input.body,
    attributes: input.eveSessionId
      ? { "eveland.eve.session.id": input.eveSessionId }
      : {},
    resource: {
      serviceName:
        input.domain === "agent" ? "eveland-agent" : "eveland-gateway",
      domain: input.domain,
      projectId: input.projectId,
      deploymentId: null,
      attributes: {},
    },
    payload: { body: input.body },
  };
}
