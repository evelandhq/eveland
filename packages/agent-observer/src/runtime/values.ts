export function asRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

export function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function serializeAttribute(value: unknown): string {
  const serialized =
    typeof value === "string" ? JSON.stringify(value) : canonicalJson(value);
  const maxLength = 65_536;
  return serialized.length <= maxLength
    ? serialized
    : `${serialized.slice(0, maxLength)}…`;
}

export function asDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
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
