import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { ensureRouteNotifyTriggers } from "./db/notify-triggers.js";
import { createStoreFromEnv } from "./store-factory.js";

const port = Number(process.env.PORT ?? 4000);
const storeFactory = createStoreFromEnv();

if (storeFactory.database) {
  await ensureRouteNotifyTriggers(storeFactory.database.client);
}

serve({
  fetch: createApp(storeFactory.store).fetch,
  port,
});

console.log(`Eveland API listening on http://localhost:${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void storeFactory.close().finally(() => process.exit(0));
  });
}
