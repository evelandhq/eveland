import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, test } from "vitest";

afterEach(() => {
  trace.disable();
});

describe("Eveland private tracer provider", () => {
  test("does not register globally or export spans through the user provider", async () => {
    const userExporter = new InMemorySpanExporter();
    const userProvider = new BasicTracerProvider({
      spanProcessors: [
        new SimpleSpanProcessor(userExporter),
      ],
    });
    const evelandExporter = new InMemorySpanExporter();
    const evelandProvider = new BasicTracerProvider({
      spanProcessors: [
        new SimpleSpanProcessor(evelandExporter),
      ],
    });

    expect(trace.setGlobalTracerProvider(userProvider)).toBe(true);

    const userSpan = trace.getTracer("user-instrumentation").startSpan("user-operation");
    const evelandSpan = evelandProvider.getTracer("@eveland/eve-runtime").startSpan("invoke_agent");
    userSpan.end();
    evelandSpan.end();
    await Promise.all([userProvider.forceFlush(), evelandProvider.forceFlush()]);

    expect(userExporter.getFinishedSpans().map((span) => span.name)).toEqual(["user-operation"]);
    expect(evelandExporter.getFinishedSpans().map((span) => span.name)).toEqual(["invoke_agent"]);

    await Promise.all([userProvider.shutdown(), evelandProvider.shutdown()]);
  });
});
