import { describe, expect, test } from "vitest";
import { countValidOtlpSpans } from "./traces.js";
import { attribute } from "./test-support.js";

describe("OTLP trace validation", () => {
  test("counts valid spans with Eveland Resource provenance", () => {
    expect(
      countValidOtlpSpans({
        resourceSpans: [
          {
            resource: {
              attributes: [
                attribute("service.name", "eveland-api"),
                attribute("eveland.telemetry.domain", "platform"),
                attribute("eveland.project.id", "proj_1"),
              ],
            },
            scopeSpans: [
              {
                scope: { name: "@opentelemetry/instrumentation-http" },
                spans: [
                  {
                    traceId: "trace_1",
                    spanId: "span_1",
                    parentSpanId: "parent_1",
                    name: "GET /projects",
                    kind: 2,
                    startTimeUnixNano: "1784808000000000000",
                    endTimeUnixNano: "1784808000125000000",
                    attributes: [attribute("http.request.method", "GET")],
                    status: { code: 1 },
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe(1);
  });

  test("ignores resources that are not marked as Eveland telemetry", () => {
    expect(
      countValidOtlpSpans({
        resourceSpans: [
          {
            resource: {
              attributes: [attribute("service.name", "user-agent")],
            },
            scopeSpans: [],
          },
        ],
      }),
    ).toBe(0);
  });
});
