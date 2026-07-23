import { createHash, randomUUID } from "node:crypto";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { SeverityNumber, type LogBody } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  TraceIdRatioBasedSampler,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import type { AgentRuntimePolicy } from "@eveland/core/observability";

export type RuntimeAgentPolicy = AgentRuntimePolicy;

export type AgentTelemetryEvent = {
  type?: unknown;
  data?: unknown;
  meta?: {
    at?: unknown;
  };
};

export type AgentTelemetryHookContext = {
  session?: {
    id?: unknown;
    parent?: {
      sessionId?: unknown;
      callId?: unknown;
    };
  };
  agent?: {
    name?: unknown;
    nodeId?: unknown;
  };
  channel?: {
    kind?: unknown;
  };
};

export type PrivateAgentTelemetryExporters = {
  traces: SpanExporter;
  logs: LogRecordExporter;
  metrics: PushMetricExporter;
};

export type PrivateAgentTelemetryRuntime = {
  capture(
    event: AgentTelemetryEvent,
    context: AgentTelemetryHookContext,
  ): Promise<void>;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

type RuntimeState = {
  sessionModels: Map<string, string>;
  turns: Map<string, Span>;
  turnStartedAt: Map<string, number>;
  steps: Map<string, Span>;
  stepStartedAt: Map<string, number>;
  actions: Map<string, Span>;
  subagents: Map<string, Span>;
};

const instrumentationScope = "@eveland/eve-runtime";
const collectedEventTypes = new Set([
  "session.started",
  "turn.started",
  "message.received",
  "message.completed",
  "result.completed",
  "actions.requested",
  "action.result",
  "input.requested",
  "authorization.required",
  "authorization.completed",
  "subagent.called",
  "subagent.started",
  "subagent.event",
  "subagent.completed",
  "step.started",
  "step.completed",
  "step.failed",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "session.waiting",
  "session.completed",
  "session.failed",
  "compaction.requested",
  "compaction.completed",
]);

export function createPrivateAgentTelemetryRuntime(input: {
  policy: RuntimeAgentPolicy;
  exporters?: PrivateAgentTelemetryExporters;
  runtimeInstanceId?: string;
  warn?: (error: unknown) => void;
  now?: () => number;
}): PrivateAgentTelemetryRuntime {
  const { policy } = input;
  const runtimeInstanceId =
    input.runtimeInstanceId ?? process.env.EVELAND_RUNTIME_INSTANCE_ID;
  const endpoint = policy.otlp.endpoint.replace(/\/+$/, "");
  const exporters = input.exporters ?? {
    traces: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    logs: new OTLPLogExporter({ url: `${endpoint}/v1/logs` }),
    metrics: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
  };
  const resource = resourceFromAttributes({
    "service.name": "eveland-agent",
    "service.instance.id": policy.resource.deploymentId,
    "deployment.environment.name": policy.resource.environment,
    "process.runtime.name": "nodejs",
    "eveland.team.id": policy.resource.teamId,
    "eveland.project.id": policy.resource.projectId,
    "eveland.release.id": policy.resource.releaseId,
    "eveland.deployment.id": policy.resource.deploymentId,
    "eveland.runtime.kind": policy.resource.runtimeKind,
    "eveland.telemetry.domain": "agent",
    ...(runtimeInstanceId
      ? { "eveland.runtime.instance.id": runtimeInstanceId }
      : {}),
  });
  const tracerProvider = new BasicTracerProvider({
    resource,
    sampler: new TraceIdRatioBasedSampler(policy.capture.sampleRatio),
    spanProcessors: [new BatchSpanProcessor(exporters.traces)],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor({
        exporter: exporters.logs,
      }),
    ],
  });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: exporters.metrics,
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [metricReader],
  });
  const tracer = tracerProvider.getTracer(instrumentationScope);
  const logger = loggerProvider.getLogger(instrumentationScope);
  const meter = meterProvider.getMeter(instrumentationScope);
  const tokenUsage = meter.createHistogram("gen_ai.client.token.usage", {
    unit: "{token}",
    description: "Number of input and output tokens used by a generative AI operation.",
  });
  const cacheTokenUsage = meter.createHistogram(
    "eveland.gen_ai.cache.token.usage",
    {
      unit: "{token}",
      description: "Number of cache read and write tokens reported by Eve.",
    },
  );
  const cost = meter.createCounter("eveland.gen_ai.cost", {
    unit: "USD",
    description: "Provider-reported generative AI cost.",
  });
  const operationDuration = meter.createHistogram(
    "gen_ai.client.operation.duration",
    {
      unit: "s",
      description: "Duration of a generative AI operation.",
    },
  );
  const agentInvocations = meter.createCounter("eveland.agent.invocations", {
    unit: "{invocation}",
    description: "Number of Eve Agent turn invocations.",
  });
  const agentFailures = meter.createCounter("eveland.agent.failures", {
    unit: "{failure}",
    description: "Number of failed Eve Agent turn invocations.",
  });
  const toolCalls = meter.createCounter("eveland.agent.tool.calls", {
    unit: "{call}",
    description: "Number of Eve tool calls.",
  });
  const state: RuntimeState = {
    sessionModels: new Map(),
    turns: new Map(),
    turnStartedAt: new Map(),
    steps: new Map(),
    stepStartedAt: new Map(),
    actions: new Map(),
    subagents: new Map(),
  };
  const now = input.now ?? Date.now;
  let stopped = false;

  async function capture(
    event: AgentTelemetryEvent,
    context: AgentTelemetryHookContext,
  ): Promise<void> {
    if (stopped || !policy.capture.enabled) return;
    try {
      const eventType = asString(event.type);
      if (!eventType || !shouldCollect(eventType, policy.capture.includeReasoning)) {
        return;
      }
      const data = asRecord(event.data) ?? {};
      const sessionId = asString(context.session?.id);
      if (!sessionId) return;
      const correlatedSpan = mapLifecycle({
        eventType,
        data,
        sessionId,
        context,
        state,
        tracer,
        tokenUsage,
        cacheTokenUsage,
        cost,
        operationDuration,
        agentInvocations,
        agentFailures,
        toolCalls,
        now,
        capture: policy.capture,
      });
      emitEventLog({
        eventType,
        event,
        context,
        sessionId,
        correlatedSpan,
        logger,
        policy,
      });
    } catch (error) {
      input.warn?.(error);
    }
  }

  async function forceFlush(): Promise<void> {
    if (stopped) return;
    await Promise.all([
      tracerProvider.forceFlush(),
      loggerProvider.forceFlush(),
      meterProvider.forceFlush(),
    ]);
  }

  async function shutdown(): Promise<void> {
    if (stopped) return;
    stopped = true;
    endAllSpans(state);
    await Promise.all([
      tracerProvider.shutdown(),
      loggerProvider.shutdown(),
      meterProvider.shutdown(),
    ]);
  }

  return { capture, forceFlush, shutdown };
}

function mapLifecycle(input: {
  eventType: string;
  data: Record<string, unknown>;
  sessionId: string;
  context: AgentTelemetryHookContext;
  state: RuntimeState;
  tracer: ReturnType<BasicTracerProvider["getTracer"]>;
  tokenUsage: ReturnType<
    ReturnType<MeterProvider["getMeter"]>["createHistogram"]
  >;
  cacheTokenUsage: ReturnType<
    ReturnType<MeterProvider["getMeter"]>["createHistogram"]
  >;
  cost: ReturnType<ReturnType<MeterProvider["getMeter"]>["createCounter"]>;
  operationDuration: ReturnType<
    ReturnType<MeterProvider["getMeter"]>["createHistogram"]
  >;
  agentInvocations: ReturnType<
    ReturnType<MeterProvider["getMeter"]>["createCounter"]
  >;
  agentFailures: ReturnType<
    ReturnType<MeterProvider["getMeter"]>["createCounter"]
  >;
  toolCalls: ReturnType<
    ReturnType<MeterProvider["getMeter"]>["createCounter"]
  >;
  now: () => number;
  capture: RuntimeAgentPolicy["capture"];
}): Span | undefined {
  const {
    eventType,
    data,
    sessionId,
    context,
    state,
    tracer,
    tokenUsage,
    cacheTokenUsage,
    cost,
    operationDuration,
    agentInvocations,
    agentFailures,
    toolCalls,
    now,
    capture,
  } = input;
  const turnId = asString(data.turnId);
  const stepIndex = asNonNegativeInteger(data.stepIndex);
  const turnKey = turnId ? key(sessionId, turnId) : undefined;
  const stepKey =
    turnId && stepIndex !== undefined
      ? key(sessionId, turnId, String(stepIndex))
      : undefined;

  switch (eventType) {
    case "session.started": {
      const runtime = asRecord(data.runtime);
      const modelId = asString(runtime?.modelId);
      if (modelId) state.sessionModels.set(sessionId, modelId);
      return undefined;
    }
    case "turn.started": {
      if (!turnId || !turnKey || state.turns.has(turnKey)) return undefined;
      const agentName =
        asString(asRecord(data.runtime)?.agentName) ??
        asString(context.agent?.name) ??
        "agent";
      const span = tracer.startSpan(
        `invoke_agent ${agentName}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: commonAttributes(sessionId, turnId, context, {
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.agent.name": agentName,
          }),
        },
        parentContext(context, state),
      );
      state.turns.set(turnKey, span);
      state.turnStartedAt.set(turnKey, now());
      agentInvocations.add(1, {
        "gen_ai.agent.name": agentName,
      });
      return span;
    }
    case "message.received": {
      const span = turnKey ? state.turns.get(turnKey) : undefined;
      const message = asString(data.message);
      if (span && message && capture.recordInputs) {
        span.setAttribute(
          "gen_ai.input.messages",
          serializeAttribute([{ role: "user", content: message }]),
        );
      }
      return span;
    }
    case "step.started": {
      if (!turnId || stepIndex === undefined || !stepKey || state.steps.has(stepKey)) {
        return turnKey ? state.turns.get(turnKey) : undefined;
      }
      const modelId = state.sessionModels.get(sessionId);
      const span = tracer.startSpan(
        modelId ? `chat ${modelId}` : "chat",
        {
          kind: SpanKind.CLIENT,
          attributes: commonAttributes(sessionId, turnId, context, {
            "gen_ai.operation.name": "chat",
            ...(modelId ? { "gen_ai.request.model": modelId } : {}),
            "eveland.eve.step.index": stepIndex,
          }),
        },
        spanContext(turnKey ? state.turns.get(turnKey) : undefined),
      );
      state.steps.set(stepKey, span);
      state.stepStartedAt.set(stepKey, now());
      return span;
    }
    case "actions.requested": {
      const actions = Array.isArray(data.actions) ? data.actions : [];
      for (const value of actions) {
        const action = asRecord(value);
        const callId = asString(action?.callId);
        if (!action || !callId) continue;
        const actionKey = key(sessionId, callId);
        const kind = asString(action.kind);
        if (kind === "subagent-call" || kind === "remote-agent-call") {
          if (state.subagents.has(actionKey)) continue;
          const agentName =
            asString(action.subagentName) ??
            asString(action.remoteAgentName) ??
            asString(action.name) ??
            "subagent";
          const span = tracer.startSpan(
            `invoke_agent ${agentName}`,
            {
              kind: SpanKind.INTERNAL,
              attributes: commonAttributes(sessionId, turnId, context, {
                "gen_ai.operation.name": "invoke_agent",
                "gen_ai.agent.name": agentName,
                "gen_ai.tool.call.id": callId,
              }),
            },
            spanContext(turnKey ? state.turns.get(turnKey) : undefined),
          );
          if (capture.recordInputs && action.input !== undefined) {
            span.setAttribute(
              "gen_ai.agent.input",
              serializeAttribute(action.input),
            );
          }
          state.subagents.set(actionKey, span);
          continue;
        }
        if (state.actions.has(actionKey)) continue;
        const toolName =
          asString(action.toolName) ??
          (kind === "load-skill" ? "load_skill" : "tool");
        const span = tracer.startSpan(
          `execute_tool ${toolName}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: commonAttributes(sessionId, turnId, context, {
              "gen_ai.operation.name": "execute_tool",
              "gen_ai.tool.name": toolName,
              "gen_ai.tool.call.id": callId,
            }),
          },
          spanContext(turnKey ? state.turns.get(turnKey) : undefined),
        );
        if (capture.recordInputs && action.input !== undefined) {
          span.setAttribute(
            "gen_ai.tool.call.arguments",
            serializeAttribute(action.input),
          );
        }
        state.actions.set(actionKey, span);
        toolCalls.add(1, {
          "gen_ai.tool.name": toolName,
        });
      }
      return stepKey
        ? state.steps.get(stepKey) ?? (turnKey ? state.turns.get(turnKey) : undefined)
        : turnKey
          ? state.turns.get(turnKey)
          : undefined;
    }
    case "action.result": {
      const result = asRecord(data.result);
      const callId = asString(result?.callId);
      if (!callId) return turnKey ? state.turns.get(turnKey) : undefined;
      const actionKey = key(sessionId, callId);
      const span =
        state.actions.get(actionKey) ?? state.subagents.get(actionKey);
      if (span) {
        if (capture.recordOutputs && result?.output !== undefined) {
          span.setAttribute(
            state.actions.has(actionKey)
              ? "gen_ai.tool.call.result"
              : "gen_ai.agent.output",
            serializeAttribute(result.output),
          );
        }
        if (data.status !== "success" || data.error !== undefined) {
          setErrorStatus(span, data);
        }
        span.end();
        state.actions.delete(actionKey);
        state.subagents.delete(actionKey);
      }
      return span;
    }
    case "message.completed": {
      const message = asString(data.message);
      const span = stepKey ? state.steps.get(stepKey) : undefined;
      if (message && capture.recordOutputs) {
        const output = serializeAttribute([
          { role: "assistant", content: message },
        ]);
        span?.setAttribute("gen_ai.output.messages", output);
        if (turnKey) {
          state.turns
            .get(turnKey)
            ?.setAttribute("gen_ai.output.messages", output);
        }
      }
      return span ?? (turnKey ? state.turns.get(turnKey) : undefined);
    }
    case "reasoning.completed": {
      const span = stepKey ? state.steps.get(stepKey) : undefined;
      const reasoning = asString(data.reasoning);
      if (span && reasoning && capture.includeReasoning) {
        span.setAttribute(
          "eveland.gen_ai.reasoning",
          serializeAttribute(reasoning),
        );
      }
      return span;
    }
    case "subagent.called":
    case "subagent.started": {
      const callId = asString(data.callId);
      if (!callId) return turnKey ? state.turns.get(turnKey) : undefined;
      const actionKey = key(sessionId, callId);
      const existing = state.subagents.get(actionKey);
      if (existing) return existing;
      const agentName =
        asString(data.name) ?? asString(data.subagentName) ?? "subagent";
      const span = tracer.startSpan(
        `invoke_agent ${agentName}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: commonAttributes(sessionId, turnId, context, {
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.agent.name": agentName,
            "gen_ai.tool.call.id": callId,
          }),
        },
        spanContext(turnKey ? state.turns.get(turnKey) : undefined),
      );
      state.subagents.set(actionKey, span);
      return span;
    }
    case "subagent.completed": {
      const callId = asString(data.callId);
      const actionKey = callId ? key(sessionId, callId) : undefined;
      const span = actionKey ? state.subagents.get(actionKey) : undefined;
      if (span) {
        if (capture.recordOutputs && data.output !== undefined) {
          span.setAttribute(
            "gen_ai.agent.output",
            serializeAttribute(data.output),
          );
        }
        span.end();
        state.subagents.delete(actionKey!);
      }
      return span;
    }
    case "step.completed":
    case "step.failed": {
      const span = stepKey ? state.steps.get(stepKey) : undefined;
      if (span) {
        if (eventType === "step.failed") setErrorStatus(span, data);
        if (eventType === "step.completed") {
          recordUsage({
            data,
            modelId: state.sessionModels.get(sessionId),
            span,
            tokenUsage,
            cacheTokenUsage,
            cost,
          });
        }
        const startedAt = state.stepStartedAt.get(stepKey!);
        if (startedAt !== undefined) {
          operationDuration.record(
            Math.max(0, now() - startedAt) / 1_000,
            {
              ...(state.sessionModels.get(sessionId)
                ? {
                    "gen_ai.request.model":
                      state.sessionModels.get(sessionId)!,
                  }
                : {}),
              "gen_ai.operation.name": "chat",
              "error.type":
                eventType === "step.failed"
                  ? asString(data.code) ?? "unknown"
                  : "",
            },
          );
        }
        span.end();
        state.steps.delete(stepKey!);
        state.stepStartedAt.delete(stepKey!);
      }
      return span;
    }
    case "turn.completed":
    case "turn.failed":
    case "turn.cancelled": {
      if (!turnKey || !turnId) return undefined;
      endTurnChildren(state, sessionId, turnId);
      const span = state.turns.get(turnKey);
      if (span) {
        if (eventType === "turn.failed") {
          setErrorStatus(span, data);
          agentFailures.add(1, {
            "gen_ai.agent.name":
              asString(context.agent?.name) ?? "agent",
            "error.type": asString(data.code) ?? "unknown",
          });
        }
        if (eventType === "turn.cancelled") {
          span.setAttribute("eveland.turn.cancelled", true);
        }
        span.end();
        state.turns.delete(turnKey);
        state.turnStartedAt.delete(turnKey);
      }
      return span;
    }
    case "session.failed":
    case "session.completed": {
      endSessionSpans(state, sessionId, eventType === "session.failed", data);
      state.sessionModels.delete(sessionId);
      return undefined;
    }
    default:
      return stepKey
        ? state.steps.get(stepKey) ?? (turnKey ? state.turns.get(turnKey) : undefined)
        : turnKey
          ? state.turns.get(turnKey)
          : undefined;
  }
}

function recordUsage(input: {
  data: Record<string, unknown>;
  modelId: string | undefined;
  span: Span;
  tokenUsage: ReturnType<
    ReturnType<MeterProvider["getMeter"]>["createHistogram"]
  >;
  cacheTokenUsage: ReturnType<
    ReturnType<MeterProvider["getMeter"]>["createHistogram"]
  >;
  cost: ReturnType<ReturnType<MeterProvider["getMeter"]>["createCounter"]>;
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
    input.tokenUsage.record(inputTokens, {
      ...modelAttributes,
      "gen_ai.token.type": "input",
    });
  }
  if (outputTokens !== undefined) {
    input.span.setAttribute("gen_ai.usage.output_tokens", outputTokens);
    input.tokenUsage.record(outputTokens, {
      ...modelAttributes,
      "gen_ai.token.type": "output",
    });
  }
  if (cacheReadTokens !== undefined) {
    input.span.setAttribute(
      "gen_ai.usage.cache_read.input_tokens",
      cacheReadTokens,
    );
    input.cacheTokenUsage.record(cacheReadTokens, {
      ...modelAttributes,
      "eveland.cache.operation": "read",
    });
  }
  if (cacheWriteTokens !== undefined) {
    input.span.setAttribute(
      "gen_ai.usage.cache_creation.input_tokens",
      cacheWriteTokens,
    );
    input.cacheTokenUsage.record(cacheWriteTokens, {
      ...modelAttributes,
      "eveland.cache.operation": "write",
    });
  }
  if (costUsd !== undefined) {
    input.span.setAttribute("eveland.gen_ai.usage.cost_usd", costUsd);
    input.cost.add(costUsd, modelAttributes);
  }
}

function emitEventLog(input: {
  eventType: string;
  event: AgentTelemetryEvent;
  context: AgentTelemetryHookContext;
  sessionId: string;
  correlatedSpan: Span | undefined;
  logger: ReturnType<LoggerProvider["getLogger"]>;
  policy: RuntimeAgentPolicy;
}): void {
  const body = sanitizeForPolicy(
    input.event,
    input.policy.capture,
    input.eventType,
  );
  const parentSessionId = asString(input.context.session?.parent?.sessionId);
  const stepIndex = asNonNegativeInteger(
    asRecord(input.event.data)?.stepIndex,
  );
  const attributes: Attributes = commonAttributes(
    input.sessionId,
    asString(asRecord(input.event.data)?.turnId),
    input.context,
    {
      "event.name": `eve.${input.eventType}`,
      "eveland.eve.event.type": input.eventType,
      "eveland.event.id": randomUUID(),
      "eveland.event.fingerprint": createHash("sha256")
        .update(input.sessionId)
        .update("\0")
        .update(canonicalJson(body))
        .digest("hex"),
      ...(parentSessionId
        ? { "eveland.eve.parent_session.id": parentSessionId }
        : {}),
      ...(stepIndex !== undefined
        ? { "eveland.eve.step.index": stepIndex }
        : {}),
    },
  );
  const eventDate = asDate(input.event.meta?.at);
  const severityNumber = severityForEvent(input.eventType);
  input.logger.emit({
    eventName: `eve.${input.eventType}`,
    body: body as LogBody,
    attributes,
    severityNumber,
    severityText: SeverityNumber[severityNumber],
    ...(eventDate ? { timestamp: eventDate } : {}),
    context: input.correlatedSpan
      ? trace.setSpan(ROOT_CONTEXT, input.correlatedSpan)
      : ROOT_CONTEXT,
  });
}

function sanitizeForPolicy(
  value: unknown,
  capture: RuntimeAgentPolicy["capture"],
  eventType: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForPolicy(item, capture, eventType));
  }
  const record = asRecord(value);
  if (!record) return isLogValue(value) ? value : String(value);

  const nestedEventType = asString(record.type) ?? eventType;
  const result: Record<string, unknown> = {};
  for (const [keyName, child] of Object.entries(record)) {
    if (isCredentialKey(keyName)) {
      result[keyName] = "[REDACTED]";
      continue;
    }
    if (!capture.recordInputs && isInputKey(nestedEventType, keyName)) {
      continue;
    }
    if (!capture.recordOutputs && isOutputKey(nestedEventType, keyName)) {
      continue;
    }
    if (!capture.includeReasoning && isReasoningKey(keyName)) continue;
    result[keyName] = sanitizeForPolicy(
      child,
      capture,
      nestedEventType,
    );
  }
  return result;
}

function shouldCollect(eventType: string, includeReasoning: boolean): boolean {
  return (
    collectedEventTypes.has(eventType) ||
    (includeReasoning && eventType === "reasoning.completed")
  );
}

function commonAttributes(
  sessionId: string,
  turnId: string | undefined,
  context: AgentTelemetryHookContext,
  attributes: Attributes,
): Attributes {
  return {
    ...attributes,
    "gen_ai.conversation.id": sessionId,
    "session.id": sessionId,
    "eveland.eve.session.id": sessionId,
    ...(turnId ? { "eveland.eve.turn.id": turnId } : {}),
    ...(asString(context.agent?.name)
      ? {
          "gen_ai.agent.name": asString(context.agent?.name)!,
          "eveland.eve.agent.name": asString(context.agent?.name)!,
        }
      : {}),
    ...(asString(context.agent?.nodeId)
      ? { "eveland.eve.agent.node.id": asString(context.agent?.nodeId)! }
      : {}),
    ...(asString(context.channel?.kind)
      ? { "eveland.eve.channel.kind": asString(context.channel?.kind)! }
      : {}),
  };
}

function parentContext(
  context: AgentTelemetryHookContext,
  state: RuntimeState,
): Context {
  const parentSessionId = asString(context.session?.parent?.sessionId);
  const callId = asString(context.session?.parent?.callId);
  return spanContext(
    parentSessionId && callId
      ? state.subagents.get(key(parentSessionId, callId))
      : undefined,
  );
}

function spanContext(span: Span | undefined): Context {
  return span ? trace.setSpan(ROOT_CONTEXT, span) : ROOT_CONTEXT;
}

function setErrorStatus(span: Span, data: Record<string, unknown>): void {
  const error = asRecord(data.error);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message:
      asString(error?.message) ??
      asString(data.message) ??
      asString(data.status) ??
      "Eve operation failed",
  });
}

function endTurnChildren(
  state: RuntimeState,
  sessionId: string,
  turnId: string,
): void {
  const prefix = key(sessionId, turnId);
  for (const [stepKey, span] of state.steps) {
    if (!stepKey.startsWith(`${prefix}\0`)) continue;
    span.end();
    state.steps.delete(stepKey);
    state.stepStartedAt.delete(stepKey);
  }
  const sessionPrefix = `${sessionId}\0`;
  for (const spans of [state.actions, state.subagents]) {
    for (const [spanKey, span] of spans) {
      if (!spanKey.startsWith(sessionPrefix)) continue;
      span.end();
      spans.delete(spanKey);
    }
  }
}

function endSessionSpans(
  state: RuntimeState,
  sessionId: string,
  failed: boolean,
  data: Record<string, unknown>,
): void {
  const prefix = `${sessionId}\0`;
  for (const spans of [state.steps, state.actions, state.subagents, state.turns]) {
    for (const [spanKey, span] of spans) {
      if (!spanKey.startsWith(prefix)) continue;
      if (failed) setErrorStatus(span, data);
      span.end();
      spans.delete(spanKey);
    }
  }
  for (const startedAt of [state.stepStartedAt, state.turnStartedAt]) {
    for (const startedAtKey of startedAt.keys()) {
      if (startedAtKey.startsWith(prefix)) startedAt.delete(startedAtKey);
    }
  }
}

function endAllSpans(state: RuntimeState): void {
  for (const spans of [state.steps, state.actions, state.subagents, state.turns]) {
    for (const span of spans.values()) span.end();
    spans.clear();
  }
  state.stepStartedAt.clear();
  state.turnStartedAt.clear();
}

function key(...parts: string[]): string {
  return parts.join("\0");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function isLogValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Uint8Array
  );
}

function isCredentialKey(keyName: string): boolean {
  const normalized = keyName.replace(/[-_]/g, "").toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "password" ||
    normalized === "secret" ||
    normalized === "token" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("idtoken") ||
    normalized.endsWith("continuationtoken") ||
    normalized.endsWith("credential")
  );
}

function isInputKey(eventType: string, keyName: string): boolean {
  if (eventType === "message.received") {
    return keyName === "message" || keyName === "parts";
  }
  if (eventType === "actions.requested") {
    return keyName === "input";
  }
  return keyName === "clientContext";
}

function isOutputKey(eventType: string, keyName: string): boolean {
  if (eventType === "message.completed") return keyName === "message";
  if (eventType === "result.completed") return keyName === "result";
  if (
    eventType === "action.result" ||
    eventType === "subagent.completed"
  ) {
    return keyName === "output";
  }
  return false;
}

function isReasoningKey(keyName: string): boolean {
  return (
    keyName === "reasoning" ||
    keyName === "reasoningDelta" ||
    keyName === "reasoningSoFar"
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function serializeAttribute(value: unknown): string {
  const serialized =
    typeof value === "string" ? JSON.stringify(value) : canonicalJson(value);
  const maxLength = 65_536;
  return serialized.length <= maxLength
    ? serialized
    : `${serialized.slice(0, maxLength)}…`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([keyName, child]) => [keyName, sortJson(child)]),
  );
}

function asDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

function severityForEvent(eventType: string): SeverityNumber {
  if (eventType.endsWith(".failed")) return SeverityNumber.ERROR;
  if (eventType.endsWith(".cancelled")) return SeverityNumber.WARN;
  return SeverityNumber.INFO;
}
