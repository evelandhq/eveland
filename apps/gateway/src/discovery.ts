import type { ServerResponse } from "node:http";
import { mintAgentUrl } from "@eveland/shared/agent-domain";
import type { GatewayConfig } from "./config.js";
import type { RouteSource } from "./route-source.js";

export async function handleDiscovery(res: ServerResponse, deps: { routeSource: RouteSource; config: GatewayConfig }): Promise<void> {
  let agents: Array<{ slug: string; name: string }>;
  try {
    agents = await deps.routeSource.listAgents();
  } catch (error) {
    console.error("Discovery listing failed:", error);
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Routing unavailable" }));
    return;
  }

  const body = {
    agents: agents.map((agent) => ({ ...agent, url: mintAgentUrl(agent.slug, deps.config.agentUrlEnv) })),
  };
  res.writeHead(200, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}
