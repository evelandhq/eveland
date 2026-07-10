export type ModelStepUsage = {
  turnId: string;
  stepIndex: number;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  usageReported: boolean;
};

export function parseStepUsageEvent(type: string, payload: unknown): ModelStepUsage | null {
  if (type !== "step.completed" || !isRecord(payload)) {
    return null;
  }

  const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
  const stepIndex = readNonNegativeInteger(payload.stepIndex);
  if (!turnId || stepIndex === null) {
    return null;
  }

  const usage = isRecord(payload.usage) ? payload.usage : null;
  const inputTokens = readNonNegativeInteger(usage?.inputTokens);
  const outputTokens = readNonNegativeInteger(usage?.outputTokens);
  const cacheReadTokens = readNonNegativeInteger(usage?.cacheReadTokens);
  const cacheWriteTokens = readNonNegativeInteger(usage?.cacheWriteTokens);
  const costUsd = readNonNegativeNumber(usage?.costUsd);

  return {
    turnId,
    stepIndex,
    finishReason: typeof payload.finishReason === "string" ? payload.finishReason : null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    usageReported: [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd].some((value) => value !== null),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
