import { and, eq } from "drizzle-orm";
import { createDatabase, type Database } from "@eveland/api/db/client";
import { deployments, projects } from "@eveland/api/db/schema";
import { isValidProjectSlug } from "@eveland/shared/agent-domain";
import type { GatewayConfig } from "./config.js";
import type { RouteSource } from "./route-source.js";

export const ROUTE_NOTIFY_CHANNEL = "eveland_routes";

export type RouteNotificationListener = {
  listen(channel: string, handler: (payload: string) => void, onlisten?: () => void): unknown;
};

export function createPostgresRouteSource(config: GatewayConfig): RouteSource {
  return createPostgresRouteSourceFromDatabase(createDatabase(config.databaseUrl));
}

export function createPostgresRouteSourceFromDatabase(database: Database): RouteSource {
  const { db, client } = database;
  const routeSelection = {
    slug: projects.slug,
    name: projects.name,
    hostAddress: deployments.hostAddress,
    hostPort: deployments.hostPort,
  };

  return {
    async lookup(slug) {
      const [row] = await db
        .select(routeSelection)
        .from(projects)
        .innerJoin(deployments, eq(deployments.id, projects.deploymentId))
        .where(and(eq(projects.slug, slug), eq(deployments.status, "running")))
        .limit(1);
      return row ?? null;
    },

    async listAgents() {
      return db
        .select({ slug: projects.slug, name: projects.name })
        .from(projects)
        .innerJoin(deployments, eq(deployments.id, projects.deploymentId))
        .where(eq(deployments.status, "running"))
        .orderBy(projects.name);
    },

    async subscribe(handlers) {
      await subscribeRouteInvalidations(client, handlers);
    },

    async close() {
      await database.close();
    },
  };
}

export async function subscribeRouteInvalidations(
  listener: RouteNotificationListener,
  handlers: { onInvalidate: (slug: string | null) => void },
): Promise<void> {
  await listener.listen(
    ROUTE_NOTIFY_CHANNEL,
    (payload) => {
      handlers.onInvalidate(parseRouteNotificationPayload(payload));
    },
    () => handlers.onInvalidate(null),
  );
}

export function parseRouteNotificationPayload(payload: string | undefined): string | null {
  const slug = payload?.trim();
  return slug && isValidProjectSlug(slug) ? slug : null;
}
