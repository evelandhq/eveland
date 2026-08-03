import { describe, expect, test } from "vitest";
import { countOtlpSignalItems, createOtlpPartialSuccessResponse } from "./response.js";

describe("OTLP response accounting", () => {
  test("counts signal items and uses the standard partial-success fields", () => {
    expect(
      countOtlpSignalItems("traces", {
        resourceSpans: [
          {
            scopeSpans: [{ spans: [{ name: "one" }, { name: "two" }] }],
          },
        ],
      }),
    ).toBe(2);
    expect(
      countOtlpSignalItems("logs", {
        resourceLogs: [
          {
            scopeLogs: [{ logRecords: [{ body: {} }, { body: {} }] }],
          },
        ],
      }),
    ).toBe(2);
    expect(
      countOtlpSignalItems("metrics", {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [{ gauge: { dataPoints: [{}, {}] } }, { histogram: { dataPoints: [{}] } }],
              },
            ],
          },
        ],
      }),
    ).toBe(3);

    expect(createOtlpPartialSuccessResponse("traces", 2)).toEqual({
      partialSuccess: {
        rejectedSpans: "2",
        errorMessage: expect.stringContaining("required"),
      },
    });
    expect(createOtlpPartialSuccessResponse("logs", 2)).toEqual({
      partialSuccess: {
        rejectedLogRecords: "2",
        errorMessage: expect.stringContaining("required"),
      },
    });
    expect(createOtlpPartialSuccessResponse("metrics", 2)).toEqual({
      partialSuccess: {
        rejectedDataPoints: "2",
        errorMessage: expect.stringContaining("required"),
      },
    });
    expect(createOtlpPartialSuccessResponse("traces", 0)).toEqual({});
  });
});
