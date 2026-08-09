import { setTimeout as delay } from "node:timers/promises";
import { main } from "@evelandhq/workflow-world/dispatcher";
import type { DispatcherTelemetry } from "@evelandhq/workflow-world/dispatcher";
import { platformObservability } from "./observability.js";

const API_HEALTH_RETRY_MS = 250;
const API_HEALTH_TIMEOUT_MS = 2_000;

async function waitForControlApi(apiUrl: string): Promise<void> {
  const healthUrl = new URL("health", `${apiUrl.replace(/\/+$/u, "")}/`).toString();
  for (;;) {
    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(API_HEALTH_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // The API commonly starts after the dispatcher under `pnpm dev`.
    }
    await delay(API_HEALTH_RETRY_MS);
  }
}

/**
 * eveland's launcher for the workflow dispatcher that ships inside
 * `@evelandhq/workflow-world`. The package owns the whole lifecycle — config,
 * migrations, boot recovery, signal handling, the stdout readiness token — and
 * deliberately carries no OTel dependency; the host decides where its
 * structured events go. This is that decision: the platform observability
 * singleton every other eveland service uses.
 */
const telemetry: DispatcherTelemetry = {
  emit(event) {
    platformObservability.emitLog(event);
  },
  async shutdown() {
    await platformObservability.shutdown();
  },
};

const activationApiUrl = process.env.WORKFLOW_DISPATCHER_ACTIVATION_API_URL;
if (activationApiUrl) await waitForControlApi(activationApiUrl);
await main(process.env, telemetry);
