import type { Store } from "@evelandhq/db";
import type { AgentCatalogResponse } from "@evelandhq/core/catalog";
import type { AppOptions, ApiApp } from "./app-types.js";
import { publicGatewayUrl } from "./app-support.js";

type AgentCatalogRoutesContext = {
  app: ApiApp;
  store: Store;
  options: AppOptions;
};

export function registerAgentCatalogRoutes({
  app,
  store,
  options,
}: AgentCatalogRoutesContext): void {
  app.get("/api/agent-catalog", async (c) => {
    c.header("cache-control", "no-store");
    try {
      const response: AgentCatalogResponse = {
        agents: (await store.listAgentCatalog()).map(({ hostname, ...agent }) => ({
          ...agent,
          url: publicGatewayUrl(hostname, options),
        })),
      };
      return c.json(response);
    } catch {
      return c.json(
        {
          code: "agent_catalog_unavailable",
          error: "The Agent Catalog is temporarily unavailable.",
        },
        503,
      );
    }
  });
}
