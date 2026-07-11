export type HostClassification = { kind: "apex" } | { kind: "agent"; slug: string } | { kind: "unknown" };

export function classifyHost(hostHeader: string | undefined, agentDomain: string): HostClassification {
  const host = normalizeHost(hostHeader);
  if (!host) {
    return { kind: "unknown" };
  }
  if (host === agentDomain) {
    return { kind: "apex" };
  }
  const suffix = `.${agentDomain}`;
  if (!host.endsWith(suffix)) {
    return { kind: "unknown" };
  }
  const slug = host.slice(0, -suffix.length);
  if (!slug || slug.includes(".")) {
    return { kind: "unknown" };
  }
  return { kind: "agent", slug };
}

function normalizeHost(hostHeader: string | undefined): string | null {
  const first = hostHeader?.split(",")[0]?.trim().toLowerCase();
  if (!first) {
    return null;
  }
  const withoutPort = first.startsWith("[") ? first : first.replace(/:\d+$/, "");
  return withoutPort.replace(/\.$/, "");
}
