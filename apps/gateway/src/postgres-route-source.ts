import type { GatewayConfig } from "./config.js";
import type { RouteSource } from "./route-source.js";

export function createPostgresRouteSource(config: GatewayConfig): RouteSource {
  void config;
  throw new Error("Postgres route source not implemented yet (Task 11).");
}
