export function agentAuthCallbackSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  if (!params.get("state")) return null;
  return `?${params.toString()}`;
}

export function safeAgentAuthReturnPath(returnPath: unknown): string {
  if (
    typeof returnPath === "string"
    && returnPath.startsWith("/")
    && !returnPath.startsWith("//")
    && !returnPath.startsWith("/\\")
  ) return returnPath;
  return "/projects";
}
