import { TELEMETRY_DOMAINS } from "@eveland/core/observability";
import {
  arrayOfRecords,
  attributesFrom,
  durationBetweenUnixNano,
  recordValue,
  stringValue,
  unixNanoToIso,
} from "./values.js";

export function countValidOtlpSpans(
  payload: Record<string, unknown>,
): number {
  let count = 0;
  for (const resourceSpans of arrayOfRecords(payload.resourceSpans)) {
    if (!isManagedResource(resourceSpans.resource)) continue;
    for (const scopeSpans of arrayOfRecords(resourceSpans.scopeSpans)) {
      for (const span of arrayOfRecords(scopeSpans.spans)) {
        if (isValidSpan(span)) count += 1;
      }
    }
  }
  return count;
}

function isManagedResource(value: unknown): boolean {
  const resource = recordValue(value);
  const attributes = attributesFrom(resource?.attributes);
  return (
    stringValue(attributes["service.name"]) !== undefined &&
    TELEMETRY_DOMAINS.some(
      (domain) => domain === attributes["eveland.telemetry.domain"],
    )
  );
}

function isValidSpan(span: Record<string, unknown>): boolean {
  const startedAt = stringValue(span.startTimeUnixNano);
  const endedAt = stringValue(span.endTimeUnixNano);
  return (
    stringValue(span.traceId) !== undefined &&
    stringValue(span.spanId) !== undefined &&
    stringValue(span.name) !== undefined &&
    unixNanoToIso(startedAt) !== undefined &&
    unixNanoToIso(endedAt) !== undefined &&
    durationBetweenUnixNano(startedAt, endedAt) !== undefined
  );
}
