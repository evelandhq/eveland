export function attribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

export function anyValue(value: unknown): Record<string, unknown> {
  if (value === null) return {};
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "boolean") return { boolValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(anyValue) } };
  }
  return {
    kvlistValue: {
      values: Object.entries(value as Record<string, unknown>).map(([key, child]) => ({
        key,
        value: anyValue(child),
      })),
    },
  };
}

export function gauge(name: string, dataPoints: Array<Record<string, unknown>>) {
  return { name, gauge: { dataPoints } };
}

export function histogram(name: string, count: number, sum: number) {
  return {
    name,
    histogram: {
      dataPoints: [
        {
          count: String(count),
          sum,
          startTimeUnixNano: "1784807940000000000",
          timeUnixNano: "1784808000000000000",
          attributes: [],
        },
      ],
    },
  };
}

export function point(value: number, attributes: Record<string, string | number> = {}) {
  return {
    asDouble: value,
    startTimeUnixNano: "1784807940000000000",
    timeUnixNano: "1784808000000000000",
    attributes: Object.entries(attributes).map(([key, child]) => ({
      key,
      value: typeof child === "number" ? { intValue: String(child) } : { stringValue: child },
    })),
  };
}
