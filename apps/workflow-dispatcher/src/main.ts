import { setTimeout as delay } from "node:timers/promises";
import { startDispatcherService } from "@evelandhq/workflow-world/dispatcher";
import type { DispatcherTelemetry } from "@evelandhq/workflow-world/dispatcher";
import {
  defaultRunnerDeps,
  resolveHeartbeatIntervalMs,
  startEvelandWorkflowDispatcher,
} from "./dispatcher-runner.js";
import { platformObservability } from "./observability.js";

const API_HEALTH_RETRY_MS = 250;
const API_HEALTH_TIMEOUT_MS = 2_000;
const SHUTDOWN_GRACE_MS = 30_000;
const SHUTDOWN_TIMEOUT_EXIT_CODE = 75;

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
 * eveland's launcher for the workflow dispatcher. The package owns ownership,
 * migrations, boot recovery and the recover-paused lifecycle; this launcher
 * owns what is the host's business — the platform observability sink, the
 * authenticated registration heartbeat to the Control API, and the resume
 * signal that heartbeat carries back.
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

const handle = await startEvelandWorkflowDispatcher(process.env, telemetry, {
  ...defaultRunnerDeps,
  startService: startDispatcherService,
});

const heartbeatTimer = setInterval(() => {
  void handle.heartbeat();
}, resolveHeartbeatIntervalMs(process.env));
heartbeatTimer.unref();

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  telemetry.emit({
    severity: "info",
    eventName: "workflow_dispatcher.shutdown",
    body: `received ${signal}; draining in-flight dispatches`,
  });
  const timer = setTimeout(() => {
    telemetry.emit({
      severity: "warn",
      eventName: "workflow_dispatcher.shutdown_timeout",
      body: `shutdown did not finish within ${String(SHUTDOWN_GRACE_MS)}ms; exiting anyway`,
    });
    process.exit(SHUTDOWN_TIMEOUT_EXIT_CODE);
  }, SHUTDOWN_GRACE_MS);
  timer.unref();
  clearInterval(heartbeatTimer);
  void handle
    .stop()
    .then(
      () => 0,
      (error: unknown) => {
        telemetry.emit({
          severity: "error",
          eventName: "workflow_dispatcher.shutdown_failed",
          body: String(error),
        });
        return 1;
      },
    )
    .then(async (code) => {
      await telemetry.shutdown().catch(() => {});
      clearTimeout(timer);
      process.exit(code);
    });
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
