/**
 * Confines the login `?next=` destination to a same-origin path. Identity
 * login continuations arrive here as `/api/identity/continue?state=...`,
 * which the front door routes back to the API on the shared public origin.
 */
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
