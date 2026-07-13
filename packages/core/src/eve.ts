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

export function isEveRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEveJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isEveRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function getEveString(parsed: Record<string, unknown> | null, key: string): string | null {
  const value = parsed?.[key];
  return typeof value === "string" ? value : null;
}

export function extractEveResponseText(parsed: Record<string, unknown> | null, rawText: string): string {
  return getEveString(parsed, "response") ?? getEveString(parsed, "content") ?? getEveString(parsed, "message") ?? rawText;
}

export function parseStepUsageEvent(type: string, payload: unknown): ModelStepUsage | null {
  if (type !== "step.completed" || !isEveRecord(payload)) {
    return null;
  }

  const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
  const stepIndex = readNonNegativeInteger(payload.stepIndex);
  if (!turnId || stepIndex === null) {
    return null;
  }

  const usage = isEveRecord(payload.usage) ? payload.usage : null;
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

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
