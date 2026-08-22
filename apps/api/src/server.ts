import { resolveSecretWithDevFallback } from "@evelandhq/core/server/dev-secrets";
import { platformObservability } from "./observability.js";
import { serve } from "@hono/node-server";
import { formatBuildInfo } from "@evelandhq/core/build-info";
import { createBuildInfoFromEnv } from "@evelandhq/core/server/build-info";
import { createApp } from "./app.js";
import { createStoreFromEnv } from "@evelandhq/db/factory";
import {
  authAccounts,
  authSessions,
  authVerifications,
  invitations,
  teamMemberships,
  teams,
  users,
} from "@evelandhq/db/schema";
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

serve({
  fetch: createApp(storeFactory.store, {
    auth,
    buildInfo,
    configurationDiagnostics: () => collectSystemConfigurationDiagnostics(process.env),
    gatewayServiceToken: resolveSecretWithDevFallback(
      process.env,
      process.env.EVELAND_GATEWAY_SERVICE_TOKEN,
      "eveland-dev-gateway-token",
    ),
  }).fetch,
  port,
});

console.log(`${formatBuildInfo(buildInfo)} listening on http://localhost:${port}`);
platformObservability.emitLog({
  severity: "info",
  eventName: "eveland.api.ready",
  body: "Eveland API is ready.",
  attributes: { "server.port": port },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void Promise.all([storeFactory.close(), platformObservability.shutdown()]).finally(() =>
      process.exit(0),
    );
  });
}
