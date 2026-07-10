/**
 * Normalizes a configured public origin (EVELAND_PUBLIC_ORIGIN) for URL
 * assembly: trims whitespace and trailing slashes so `${origin}/a/${shortId}`
 * never doubles a separator. Returns null when the value is unset or blank so
 * callers can apply their own fallback.
 */
export function normalizePublicOrigin(value: string | undefined | null): string | null {
  const normalized = value?.trim().replace(/\/+$/, "");
  return normalized || null;
}
