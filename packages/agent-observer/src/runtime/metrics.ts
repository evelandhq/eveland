import type { Attributes, Span } from "@opentelemetry/api";
import type { MeterProvider } from "@opentelemetry/sdk-metrics";
import {
  asNonNegativeInteger,
  asNonNegativeNumber,
  asRecord,
} from "./values.js";

type Meter = ReturnType<MeterProvider["getMeter"]>;

export type AgentTelemetryMetrics = ReturnType<
  typeof createAgentTelemetryMetrics
>;

export function createAgentTelemetryMetrics(meter: Meter) {
  return {
    tokenUsage: meter.createHistogram("gen_ai.client.token.usage", {
      unit: "{token}",
      description:
        "Number of input and output tokens used by a generative AI operation.",
    }),
    cacheTokenUsage: meter.createHistogram(
      "eveland.gen_ai.cache.token.usage",
      {
        unit: "{token}",
        description: "Number of cache read and write tokens reported by Eve.",
      },
    ),
    cost: meter.createCounter("eveland.gen_ai.cost", {
      unit: "USD",
      description: "Provider-reported generative AI cost.",
    }),
    operationDuration: meter.createHistogram(
      "gen_ai.client.operation.duration",
      {
        unit: "s",
        description: "Duration of a generative AI operation.",
      },
    ),
    agentInvocations: meter.createCounter("eveland.agent.invocations", {
      unit: "{invocation}",
      description: "Number of Eve Agent turn invocations.",
    }),
    agentFailures: meter.createCounter("eveland.agent.failures", {
      unit: "{failure}",
      description: "Number of failed Eve Agent turn invocations.",
    }),
    toolCalls: meter.createCounter("eveland.agent.tool.calls", {
      unit: "{call}",
      description: "Number of Eve tool calls.",
    }),
  };
}

export function recordUsage(input: {
  data: Record<string, unknown>;
  modelId: string | undefined;
  span: Span;
  metrics: AgentTelemetryMetrics;
}): void {
  const usage = asRecord(input.data.usage);
  if (!usage) return;
  const modelAttributes: Attributes = input.modelId
    ? { "gen_ai.request.model": input.modelId }
    : {};
  const inputTokens = asNonNegativeInteger(usage.inputTokens);
  const outputTokens = asNonNegativeInteger(usage.outputTokens);
  const cacheReadTokens = asNonNegativeInteger(usage.cacheReadTokens);
  const cacheWriteTokens = asNonNegativeInteger(usage.cacheWriteTokens);
  const costUsd = asNonNegativeNumber(usage.costUsd);

  if (inputTokens !== undefined) {
    input.span.setAttribute("gen_ai.usage.input_tokens", inputTokens);
    input.metrics.tokenUsage.record(inputTokens, {
      ...modelAttributes,
      "gen_ai.token.type": "input",
    });
  }
  if (outputTokens !== undefined) {
    input.span.setAttribute("gen_ai.usage.output_tokens", outputTokens);
    input.metrics.tokenUsage.record(outputTokens, {
      ...modelAttributes,
      "gen_ai.token.type": "output",
    });
  }
  if (cacheReadTokens !== undefined) {
    input.span.setAttribute(
      "gen_ai.usage.cache_read.input_tokens",
      cacheReadTokens,
    );
    input.metrics.cacheTokenUsage.record(cacheReadTokens, {
      ...modelAttributes,
      "eveland.cache.operation": "read",
    });
  }
  if (cacheWriteTokens !== undefined) {
    input.span.setAttribute(
      "gen_ai.usage.cache_creation.input_tokens",
      cacheWriteTokens,
    );
    input.metrics.cacheTokenUsage.record(cacheWriteTokens, {
      ...modelAttributes,
      "eveland.cache.operation": "write",
    });
  }
  if (costUsd !== undefined) {
    input.span.setAttribute("eveland.gen_ai.usage.cost_usd", costUsd);
    input.metrics.cost.add(costUsd, modelAttributes);
  }
}
