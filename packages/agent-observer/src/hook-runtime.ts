import { readFile } from "node:fs/promises";
import { AGENT_RUNTIME_POLICY_PATH } from "@evelandhq/core/observability";
import { createPolicyManagedAgentTelemetry } from "./policy-runtime.js";
import { modelCallCapture } from "./runtime/model-capture.js";
import type { AgentTelemetryEvent, AgentTelemetryHookContext } from "./runtime.js";

let lastWarningAt = 0;

// Hooks load at Agent startup, before any model call, so the capture sees
// every call the AI SDK dispatches in this process.
modelCallCapture.install();

const telemetry = createPolicyManagedAgentTelemetry({
  loadPolicy: async () => JSON.parse(await readFile(AGENT_RUNTIME_POLICY_PATH, "utf8")) as unknown,
  warn: warnRateLimited,
});

/**
 * A plain Eve hook configuration, deliberately NOT wrapped in `defineHook`:
 * this module is bundled fully self-contained so the Worker can deliver the
 * current build into the observability mount of every deployment, where the
 * Agent's `eve/hooks` is not resolvable. The shim baked into each release
 * imports `defineHook` from the Agent's own Eve installation and wraps this
 * default export. Every shim ever shipped consumes this shape, so the default
 * export must remain a plain hook configuration; an incompatible change needs
 * a new mounted file name, not a new export shape.
 */
export default {
  events: {
    async "*"(event: AgentTelemetryEvent, context: AgentTelemetryHookContext): Promise<void> {
      await telemetry.capture(event, context);
      if (event.type === "session.completed" || event.type === "session.failed") {
        await telemetry.forceFlush();
      }
    },
  },
};

function warnRateLimited(error: unknown): void {
  const now = Date.now();
  if (now - lastWarningAt < 60_000) return;
  lastWarningAt = now;
  console.warn(
    "[eveland-observer] telemetry degraded:",
    error instanceof Error ? error.message : String(error),
  );
}
