import type { SystemConfigurationDiagnostics } from "@evelandhq/core/config-diagnostics";
import type {
  InstanceComponentHealth,
  WorkflowDispatchWorkload,
} from "@evelandhq/core/instance-health";
import { resolveWorkflowWorldPlatformUrl } from "@evelandhq/core/workflow-world-url";
import { collectWorkflowDispatchWorkload } from "@evelandhq/db/workflow-world-health";
import type { ApiApp } from "./app-types.js";
import {
  collectInstanceHealth,
  probeGatewayHealth,
  type InstanceHealthReadStore,
} from "./instance-health.js";

type ComponentObservation = Omit<InstanceComponentHealth, "key" | "label">;

export function registerSystemDiagnosticsRoutes(input: {
  app: ApiApp;
  store: InstanceHealthReadStore;
  configurationDiagnostics?: () => Promise<SystemConfigurationDiagnostics>;
  gatewayHealth?: () => Promise<ComponentObservation>;
  workflowWorkload?: () => Promise<WorkflowDispatchWorkload | null>;
}) {
  const { app, store, configurationDiagnostics, gatewayHealth, workflowWorkload } = input;

  app.get("/api/system/configuration", async (c) => {
    if (!configurationDiagnostics) {
      return c.json({ error: "Configuration diagnostics unavailable" }, 503);
    }
    try {
      return c.json(await configurationDiagnostics());
    } catch {
      return c.json({ error: "Configuration diagnostics unavailable" }, 503);
    }
  });

  app.get("/api/system/health", async (c) => {
    const requestedHours = Number(c.req.query("hours") ?? 24);
    const historyHours = Number.isFinite(requestedHours)
      ? Math.max(1, Math.min(168, Math.round(requestedHours)))
      : 24;
    try {
      return c.json(
        await collectInstanceHealth(store, {
          historyHours,
          gatewayHealth: gatewayHealth ?? (() => probeGatewayHealth(process.env)),
          workflowWorkload:
            workflowWorkload ??
            (() => collectWorkflowDispatchWorkload(resolveWorkflowWorldPlatformUrl(process.env))),
        }),
      );
    } catch {
      return c.json({ error: "Instance health diagnostics unavailable" }, 503);
    }
  });
}
