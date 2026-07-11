import { customAlphabet } from "nanoid";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const RESERVED_PROJECT_SLUGS: ReadonlySet<string> = new Set(["www", "api", "gateway", "eveland", "admin"]);

export function isValidProjectSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !RESERVED_PROJECT_SLUGS.has(slug);
}

// The shared createId alphabet contains uppercase, which is not DNS-safe.
const slugSuffix = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 4);

export function createSlugSuffix(): string {
  return slugSuffix();
}

export function slugifyProjectName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "agent";
}

export function normalizeAgentDomain(value: string | undefined): string | null {
  const domain = value?.trim().replace(/\.$/, "").toLowerCase();
  return domain ? domain : null;
}

export type AgentUrlEnv = {
  EVELAND_AGENT_DOMAIN?: string;
  EVELAND_AGENT_URL_SCHEME?: string;
  EVELAND_AGENT_URL_PORT?: string;
};

export function mintAgentUrl(slug: string, env: AgentUrlEnv): string | null {
  const domain = normalizeAgentDomain(env.EVELAND_AGENT_DOMAIN);
  if (!domain) {
    return null;
  }
  const scheme = env.EVELAND_AGENT_URL_SCHEME?.trim() || "http";
  const port = env.EVELAND_AGENT_URL_PORT?.trim();
  return `${scheme}://${slug}.${domain}${port ? `:${port}` : ""}`;
}
