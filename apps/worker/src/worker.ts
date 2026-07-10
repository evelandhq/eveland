import { inferEveRuntimeCommand } from "@eveland/shared/runtime";
import { createStoreFromEnv } from "@eveland/api/store-factory";
import { processNextJob } from "./jobs/process.js";
import { assertWorkerPreflight } from "./runtime/preflight.js";

const intervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;
const storeFactory = createStoreFromEnv();

console.log(`Eveland worker ready. Poll interval: ${intervalMs}ms`);
console.log(
  `Default eve runtime command: ${inferEveRuntimeCommand({
    scripts: {},
  })}`,
);

// A misconfigured systemd host would otherwise only surface on the first
// deployment attempt; fail fast here with the complete list of what's missing.
try {
  await assertWorkerPreflight(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function tick() {
  try {
    await processNextJob(storeFactory.store, workerId);
  } catch (error) {
    console.error(error);
  }
}

void tick();
const timer = setInterval(() => {
  void tick();
}, intervalMs);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    void storeFactory.close().finally(() => process.exit(0));
  });
}
