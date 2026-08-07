import { main } from "@evelandhq/workflow-world/dispatcher";
import type { DispatcherTelemetry } from "@evelandhq/workflow-world/dispatcher";
import { platformObservability } from "./observability.js";

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

await main(process.env, telemetry);
