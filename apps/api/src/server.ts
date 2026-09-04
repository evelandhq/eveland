import { resolveSecretWithDevFallback } from "@evelandhq/core/server/dev-secrets";
import { API_PORT } from "@evelandhq/core/ports";
import { platformObservability } from "./observability.js";
import { serve } from "@hono/node-server";
import { formatBuildInfo } from "@evelandhq/core/build-info";
import { createBuildInfoFromEnv } from "@evelandhq/core/server/build-info";
import { createApp } from "./app.js";
import { createStoreFromEnv } from "@evelandhq/db/factory";
import {
  authAccounts,
  authDeviceCodes,
  authSessions,
  authVerifications,
  invitations,
  oauthAccessTokens,
  oauthClientAssertions,
  oauthClientResources,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  oauthResources,
  teamMemberships,
  teams,
  users,
} from "@evelandhq/db/schema";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createBetterAuthRuntime } from "./auth.js";
import { resolveAdminConfig, resolveBetterAuthConfig } from "./auth-config.js";
import { collectSystemConfigurationDiagnostics } from "./config-diagnostics.js";
import { createDockerBridgeIngress, resolveDockerBridgeBindHost } from "./docker-bridge-ingress.js";

const port = Number(process.env.PORT ?? API_PORT);
// Loopback by default: the front door is the only public listener. A
// containerized API (Compose) overrides this to 0.0.0.0.
const bindHost = process.env.EVELAND_API_BIND_HOST ?? "127.0.0.1";
const dockerBridgeBindHost = resolveDockerBridgeBindHost(process.env);
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
    deviceCode: authDeviceCodes,
    oauthClient: oauthClients,
    oauthResource: oauthResources,
    oauthClientResource: oauthClientResources,
    oauthAccessToken: oauthAccessTokens,
    oauthRefreshToken: oauthRefreshTokens,
    oauthConsent: oauthConsents,
    oauthClientAssertion: oauthClientAssertions,
  },
});
const auth = createBetterAuthRuntime({ database: authDatabase, ...betterAuthConfig });
await auth.bootstrapDefaultAdmin(resolveAdminConfig(process.env));
await auth.bootstrapCliOAuthClient();

const app = createApp(storeFactory.store, {
  auth,
  buildInfo,
  configurationDiagnostics: () => collectSystemConfigurationDiagnostics(process.env),
  gatewayServiceToken: resolveSecretWithDevFallback(
    process.env,
    process.env.EVELAND_GATEWAY_SERVICE_TOKEN,
    "eveland-dev-gateway-token",
  ),
});

serve({
  fetch: app.fetch,
  port,
  hostname: bindHost,
});

if (dockerBridgeBindHost) {
  // The ctl re-detects this address on every start, but the unit that reads
  // it starts again at every boot with no ctl in the loop. If Docker
  // renumbered its bridge in between, the bind fails with EADDRNOTAVAIL —
  // asynchronously, on this server's 'error' event, which unhandled would
  // take the API's primary listener down with it. Losing Agent event
  // delivery is bad; losing the whole API is worse.
  const bridge = serve(
    {
      fetch: createDockerBridgeIngress((request) => app.fetch(request)),
      port,
      hostname: dockerBridgeBindHost,
    },
    () =>
      console.log(
        `Docker bridge runtime ingress listening on http://${dockerBridgeBindHost}:${port}`,
      ),
  );
  bridge.on("error", (error: NodeJS.ErrnoException) => {
    const detail =
      `The Collector-facing listener on ${dockerBridgeBindHost}:${port} failed ` +
      `(${error.code ?? error.message}), so Agent events will not be delivered. ` +
      "Docker's bridge has most likely been renumbered since this unit's environment was " +
      "written: re-run `eveland-ctl start` to re-detect it.";
    console.error(detail);
    platformObservability.emitLog({
      severity: "error",
      eventName: "eveland.api.docker_bridge_unavailable",
      body: detail,
      attributes: { "server.address": dockerBridgeBindHost, "error.type": error.code ?? "unknown" },
    });
  });
}

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
