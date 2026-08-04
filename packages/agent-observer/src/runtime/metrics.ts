import type { Attributes, Span } from "@opentelemetry/api";
import type { MeterProvider } from "@opentelemetry/sdk-metrics";
import {
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOKEN_TYPE,
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_TOKEN_TYPE_VALUE_INPUT,
  GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
  METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
  METRIC_GEN_AI_CLIENT_TOKEN_USAGE,
} from "@opentelemetry/semantic-conventions/incubating";
import { asNonNegativeInteger, asNonNegativeNumber, asRecord } from "./values.js";

type Meter = ReturnType<MeterProvider["getMeter"]>;

export type AgentTelemetryMetrics = ReturnType<typeof createAgentTelemetryMetrics>;

export function createAgentTelemetryMetrics(meter: Meter) {
  return {
    tokenUsage: meter.createHistogram(METRIC_GEN_AI_CLIENT_TOKEN_USAGE, {
      unit: "{token}",
      description: "Number of input and output tokens used by a generative AI operation.",
    }),
    cacheTokenUsage: meter.createHistogram("eveland.gen_ai.cache.token.usage", {
      unit: "{token}",
      description: "Number of cache read and write tokens reported by Eve.",
    }),
    cost: meter.createCounter("eveland.gen_ai.cost", {
      unit: "USD",
      description: "Provider-reported generative AI cost.",
    }),
    operationDuration: meter.createHistogram(METRIC_GEN_AI_CLIENT_OPERATION_DURATION, {
      unit: "s",
      description: "Duration of a generative AI operation.",
    }),
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
    ? { [ATTR_GEN_AI_REQUEST_MODEL]: input.modelId }
    : {};
  const inputTokens = asNonNegativeInteger(usage.inputTokens);
  const outputTokens = asNonNegativeInteger(usage.outputTokens);
  const cacheReadTokens = asNonNegativeInteger(usage.cacheReadTokens);
  const cacheWriteTokens = asNonNegativeInteger(usage.cacheWriteTokens);
  const costUsd = asNonNegativeNumber(usage.costUsd);

  if (inputTokens !== undefined) {
    input.span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, inputTokens);
    input.metrics.tokenUsage.record(inputTokens, {
      ...modelAttributes,
      [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_INPUT,
    });
  }
  if (outputTokens !== undefined) {
    input.span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, outputTokens);
    input.metrics.tokenUsage.record(outputTokens, {
      ...modelAttributes,
      [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
    });
  }
  if (cacheReadTokens !== undefined) {
    input.span.setAttribute(ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, cacheReadTokens);
    input.metrics.cacheTokenUsage.record(cacheReadTokens, {
      ...modelAttributes,
      "eveland.cache.operation": "read",
    });
  }
  if (cacheWriteTokens !== undefined) {
    input.span.setAttribute(ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS, cacheWriteTokens);
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
