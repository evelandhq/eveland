export function safeLoginNextPath(value: string | undefined): string {
  if (
    value &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\") &&
    !value.includes("\0")
  ) {
    return value;
  }
  return "/projects";
}

export function buildIdentityInternalContinuationUrl(
  state: string,
  apiOrigin: string,
): string {
  const normalizedState = state.trim();
  if (!normalizedState) throw new Error("Identity continuation state is required.");
  const url = new URL("/identity/internal/continue", apiOrigin);
  url.searchParams.set("state", normalizedState);
  return url.toString();
}
