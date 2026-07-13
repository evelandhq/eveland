import { serve } from "@hono/node-server";
import path from "node:path";
import { createCollectorRuntime } from "@eveland/session-collector";
import { createApp } from "./app.js";
import { createStoreFromEnv } from "@eveland/db/factory";

const port = Number(process.env.PORT ?? 4000);
const storeFactory = createStoreFromEnv();
const collectorMode = process.env.EVELAND_COLLECTOR_MODE ?? "embedded";
const collector =
  collectorMode === "disabled"
    ? null
    : createCollectorRuntime({
        rootDir:
          process.env.EVELAND_OBSERVER_ROOT ??
          path.join(process.env.EVELAND_DATA_DIR ?? ".eveland-data", "observer"),
        ingest: (envelope) => storeFactory.store.ingestObserverEnvelope(envelope).then(() => undefined),
      });
collector?.start();

serve({
  fetch: createApp(storeFactory.store, { collectorHealth: collector ? () => collector.getHealth() : undefined }).fetch,
  port,
});

console.log(`Eveland API listening on http://localhost:${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (collector?.stop() ?? Promise.resolve()).finally(() => storeFactory.close().finally(() => process.exit(0)));
  });
}
