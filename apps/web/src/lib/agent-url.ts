import type { Project } from "./api";

export type AgentUrlDisplay =
  | { configured: true; href: string; hostLabel: string; fullLabel: string }
  | { configured: false; hostLabel: string; fullLabel: string };

export function getAgentUrlDisplay(project: Pick<Project, "slug" | "agentUrl"> | null): AgentUrlDisplay {
  if (!project?.agentUrl) {
    return {
      configured: false,
      hostLabel: "Agent URL not configured",
      fullLabel: "Set EVELAND_AGENT_DOMAIN on the API to publish agent links.",
    };
  }

  try {
    const url = new URL(project.agentUrl);
    const slugPrefix = `${project.slug}.`;
    const hostLabel = url.hostname.startsWith(slugPrefix) ? `.${url.hostname.slice(slugPrefix.length)}${url.port ? `:${url.port}` : ""}` : url.host;
    return { configured: true, href: url.toString(), hostLabel, fullLabel: url.toString() };
  } catch {
    return { configured: true, href: project.agentUrl, hostLabel: project.agentUrl, fullLabel: project.agentUrl };
  }
}
