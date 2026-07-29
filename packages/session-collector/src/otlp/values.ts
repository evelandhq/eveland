export function attributesFrom(value: unknown): Record<string, unknown> {
  return Object.fromEntries(
    arrayOfRecords(value).flatMap((attribute) => {
      const key = stringValue(attribute.key);
      return key ? [[key, anyValue(attribute.value)]] : [];
    }),
  );
}

export function metricDataPoints(
  metric: Record<string, unknown>,
): Record<string, unknown>[] {
  for (const kind of [
    "gauge",
    "sum",
    "histogram",
    "exponentialHistogram",
    "summary",
  ] as const) {
    const data = recordValue(metric[kind]);
    if (data) return arrayOfRecords(data.dataPoints);
  }
  return [];
}

export function numberValue(
  point: Record<string, unknown> | undefined,
): number | undefined {
  if (!point) return undefined;
  for (const field of ["asDouble", "asInt"] as const) {
    if (!(field in point)) continue;
    const parsed = Number(point[field]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function histogramMean(
  point: Record<string, unknown> | undefined,
): number | undefined {
  if (!point) return undefined;
  const count = Number(point.count);
  const sum = Number(point.sum);
  return Number.isFinite(count) &&
    count > 0 &&
    Number.isFinite(sum)
    ? sum / count
    : undefined;
}

export function anyValue(value: unknown): unknown {
  const record = recordValue(value);
  if (!record) return undefined;
  if ("stringValue" in record) {
    return stringValue(record.stringValue) ?? "";
  }
  if ("boolValue" in record) return record.boolValue === true;
  if ("intValue" in record) {
    const parsed = Number(record.intValue);
    return Number.isSafeInteger(parsed)
      ? parsed
      : String(record.intValue);
  }
  if ("doubleValue" in record) {
    const parsed = Number(record.doubleValue);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const arrayValue = recordValue(record.arrayValue);
  if (arrayValue) {
    return arrayOfRecords(arrayValue.values).map(anyValue);
  }
  const keyValueList = recordValue(record.kvlistValue);
  if (keyValueList) {
    return Object.fromEntries(
      arrayOfRecords(keyValueList.values).flatMap((entry) => {
        const key = stringValue(entry.key);
        return key ? [[key, anyValue(entry.value)]] : [];
      }),
    );
  }
  if ("bytesValue" in record) return stringValue(record.bytesValue);
  return null;
}

export function unixNanoToIso(
  value: string | undefined,
): string | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  try {
    const milliseconds = Number(BigInt(value) / 1_000_000n);
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime())
      ? undefined
      : date.toISOString();
  } catch {
    return undefined;
  }
}

export function durationBetweenUnixNano(
  start: string | undefined,
  end: string | undefined,
): number | undefined {
  if (
    !start ||
    !end ||
    !/^\d+$/.test(start) ||
    !/^\d+$/.test(end)
  ) {
    return undefined;
  }
  try {
    const duration = BigInt(end) - BigInt(start);
    if (duration < 0n) return undefined;
    const milliseconds = Number(duration) / 1_000_000;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  } catch {
    return undefined;
  }
}

export function arrayOfRecords(
  value: unknown,
): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = recordValue(item);
        return record ? [record] : [];
      })
    : [];
}

export function recordValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value
    : undefined;
}

export function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}
