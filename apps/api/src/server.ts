import { serve } from "@hono/node-server";
import path from "node:path";
import { createCollectorRuntime } from "@eveland/session-collector";
import { createApp } from "./app.js";
import { createStoreFromEnv } from "@eveland/db/factory";
import { argon2PasswordHasher, createAuthService } from "./auth.js";
import { resolveAdminConfig } from "./auth-config.js";

const port = Number(process.env.PORT ?? 4000);
const storeFactory = createStoreFromEnv();
const auth = createAuthService(storeFactory.store, { hasher: argon2PasswordHasher });
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
    collectorHealth: collector ? () => collector.getHealth() : undefined,
  }).fetch,
  port,
});

console.log(`Eveland API listening on http://localhost:${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (collector?.stop() ?? Promise.resolve()).finally(() => storeFactory.close().finally(() => process.exit(0)));
  });
}
