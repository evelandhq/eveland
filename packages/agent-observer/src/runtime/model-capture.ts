import { asNonNegativeInteger, asRecord, asString } from "./values.js";

/**
 * A model call observed through the AI SDK telemetry registry. `modelId` is
 * the id the runtime resolved and actually invoked — Eve's event stream only
 * ever reports the compile-time manifest value (evelandhq/eveland#263), so
 * this is the sole source of the real per-call model until vercel/eve#1593
 * puts it on `step.completed`. `responseModelId` is the id the provider
 * echoed back for the response.
 */
export type ObservedModelCall = {
  modelId: string;
  responseModelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
};

export type ObservedStepUsage = {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  finishReason: string | undefined;
};

export type ModelCallCapture = {
  install(): void;
  take(step: ObservedStepUsage): ObservedModelCall | undefined;
};

type AiSdkTelemetryGlobal = {
  AI_SDK_TELEMETRY_INTEGRATIONS?: Array<Record<string, unknown>>;
};

/**
 * Concurrent turns can interleave a handful of calls between an `onStepEnd`
 * and the matching `step.completed` hook event; anything older than this is
 * an orphan (its step failed or its event was dropped) and gets evicted.
 */
const maxBufferedCalls = 16;

/**
 * Observes the Agent's own AI SDK model calls via the registry declared in
 * ai 7.x as `globalThis.AI_SDK_TELEMETRY_INTEGRATIONS`. The array is written
 * directly instead of through `registerTelemetry()` because this module runs
 * from the observability mount, where the Agent's `ai` package is not
 * resolvable; the assignment is what `registerTelemetry()` does. The AI SDK
 * awaits integration callbacks inside the model-call path, so a throw here
 * would fail the Agent's own call — every callback must swallow instead.
 */
export function createModelCallCapture(
  target: AiSdkTelemetryGlobal = globalThis as AiSdkTelemetryGlobal,
): ModelCallCapture {
  const buffer: ObservedModelCall[] = [];
  let installed = false;

  function onStepEnd(event: unknown): void {
    try {
      const step = asRecord(event);
      const modelId = asString(asRecord(step?.model)?.modelId);
      if (!modelId) return;
      const responseModelId = asString(asRecord(step?.response)?.modelId);
      const usage = asRecord(step?.usage);
      buffer.push({
        modelId,
        ...(responseModelId ? { responseModelId } : {}),
        inputTokens: asNonNegativeInteger(usage?.inputTokens),
        outputTokens: asNonNegativeInteger(usage?.outputTokens),
        finishReason: asString(step?.finishReason),
      });
      if (buffer.length > maxBufferedCalls) buffer.splice(0, buffer.length - maxBufferedCalls);
    } catch {
      // Never propagate into the Agent's model call.
    }
  }

  return {
    install(): void {
      if (installed) return;
      installed = true;
      try {
        (target.AI_SDK_TELEMETRY_INTEGRATIONS ??= []).push({ onStepEnd });
      } catch {
        // A frozen or exotic globalThis leaves the observer on manifest ids.
      }
    },
    take(step: ObservedStepUsage): ObservedModelCall | undefined {
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        if (matchesStep(buffer[index]!, step)) return buffer.splice(index, 1)[0];
      }
      // Compaction calls also pass through `onStepEnd` but never match a
      // step's exact usage, so a miss on a usage-bearing step returns nothing
      // rather than risk attributing the compaction model. Only a step that
      // reported no usage at all falls back to the newest entry — in the
      // dominant single-model process, a correct guess.
      if (step.inputTokens !== undefined || step.outputTokens !== undefined) return undefined;
      return buffer.pop();
    },
  };
}

/**
 * Eve copies the AI SDK usage numbers into `step.completed` unchanged
 * (`extractStepUsage`), so equality on both token counts identifies the call.
 * Token counts alone can collide across concurrent turns; `finishReason`
 * breaks the tie when both sides carry it.
 */
function matchesStep(entry: ObservedModelCall, step: ObservedStepUsage): boolean {
  if (step.inputTokens === undefined || step.outputTokens === undefined) return false;
  if (entry.inputTokens !== step.inputTokens || entry.outputTokens !== step.outputTokens) {
    return false;
  }
  if (entry.finishReason === undefined || step.finishReason === undefined) return true;
  return normalizeFinishReason(entry.finishReason) === step.finishReason;
}

/**
 * Mirrors Eve's `normalizeAssistantStepFinishReason`: the step event carries
 * the normalized value, so the AI SDK side must be normalized the same way
 * before comparing (e.g. the SDK's "unknown" arrives as "other").
 */
function normalizeFinishReason(value: string): string {
  switch (value) {
    case "content-filter":
    case "error":
    case "length":
    case "stop":
    case "tool-calls":
      return value;
    default:
      return "other";
  }
}

export const modelCallCapture: ModelCallCapture = createModelCallCapture();
