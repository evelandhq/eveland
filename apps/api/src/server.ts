import { serve } from "@hono/node-server";
import path from "node:path";
import { formatBuildInfo } from "@eveland/core/build-info";
import { createBuildInfoFromEnv } from "@eveland/core/server/build-info";
import { createCollectorRuntime } from "@eveland/session-collector";
import { createApp } from "./app.js";
import { createStoreFromEnv } from "@eveland/db/factory";
import {
  authAccounts,
  authSessions,
  authVerifications,
  invitations,
  teamMemberships,
  teams,
  users,
} from "@eveland/db/schema";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createBetterAuthRuntime } from "./auth.js";
import { resolveAdminConfig, resolveBetterAuthConfig } from "./auth-config.js";
import { collectSystemConfigurationDiagnostics } from "./config-diagnostics.js";

const port = Number(process.env.PORT ?? 4000);
const buildInfo = createBuildInfoFromEnv("api", process.env);
const storeFactory = createStoreFromEnv();
const betterAuthConfig = resolveBetterAuthConfig(process.env);
const authDatabase = drizzleAdapter(storeFactory.database.db, {
  provider: "pg",
  schema: {
    user: users,
    session: authSessions,
    account: authAccounts,
    verification: authVerifications,
    organization: teams,
    member: teamMemberships,
    invitation: invitations,
  },
});
const auth = createBetterAuthRuntime({ database: authDatabase, ...betterAuthConfig });
await auth.bootstrapDefaultAdmin(resolveAdminConfig(process.env));
const collectorMode = process.env.EVELAND_COLLECTOR_MODE ?? "embedded";
const collector =
  collectorMode === "disabled"
    ? null
    : createCollectorRuntime({
        rootDir:
          process.env.EVELAND_OBSERVER_ROOT ??
          path.join(process.env.EVELAND_DATA_DIR ?? ".eveland-data", "observer"),
        maxConcurrentSessions: Number(process.env.EVELAND_COLLECTOR_MAX_CONCURRENT_SESSIONS ?? 100),
        maxBacklogBytes: Number(process.env.EVELAND_COLLECTOR_MAX_BACKLOG_BYTES ?? 1_073_741_824),
        ingest: (envelope) => storeFactory.store.ingestObserverEnvelope(envelope).then(() => undefined),
      });
collector?.start();

serve({
  fetch: createApp(storeFactory.store, {
    auth,
    buildInfo,
    collectorHealth: collector ? () => collector.getHealth() : undefined,
    configurationDiagnostics: () => collectSystemConfigurationDiagnostics(process.env),
    gatewayServiceToken:
      process.env.EVELAND_GATEWAY_SERVICE_TOKEN ??
      (process.env.NODE_ENV === "production" ? undefined : "eveland-dev-gateway-token"),
  }).fetch,
  port,
});

console.log(`${formatBuildInfo(buildInfo)} listening on http://localhost:${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (collector?.stop() ?? Promise.resolve()).finally(() => storeFactory.close().finally(() => process.exit(0)));
  });
}
