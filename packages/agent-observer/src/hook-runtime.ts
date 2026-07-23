import { readFile } from "node:fs/promises";
import { AGENT_RUNTIME_POLICY_PATH } from "@eveland/core/observability";
import { defineHook } from "eve/hooks";
import { createPolicyManagedAgentTelemetry } from "./policy-runtime.js";

let lastWarningAt = 0;

const telemetry = createPolicyManagedAgentTelemetry({
  loadPolicy: async () =>
    JSON.parse(await readFile(AGENT_RUNTIME_POLICY_PATH, "utf8")) as unknown,
  warn: warnRateLimited,
});

export default defineHook({
  events: {
    async "*"(event, context) {
      await telemetry.capture(event, context);
      if (
        event.type === "session.completed" ||
        event.type === "session.failed"
      ) {
        await telemetry.forceFlush();
      }
    },
  },
});

function warnRateLimited(error: unknown): void {
  const now = Date.now();
  if (now - lastWarningAt < 60_000) return;
  lastWarningAt = now;
  console.warn(
    "[eveland-observer] telemetry degraded:",
    error instanceof Error ? error.message : String(error),
  );
}
