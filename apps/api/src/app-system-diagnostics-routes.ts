import type { SystemConfigurationDiagnostics } from "@eveland/core/config-diagnostics";
import type { InstanceComponentHealth } from "@eveland/core/instance-health";
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
}) {
  const { app, store, configurationDiagnostics, gatewayHealth } = input;

  app.get("/system/configuration", async (c) => {
    if (!configurationDiagnostics) {
      return c.json({ error: "Configuration diagnostics unavailable" }, 503);
    }
    try {
      return c.json(await configurationDiagnostics());
    } catch {
      return c.json({ error: "Configuration diagnostics unavailable" }, 503);
    }
  });

  app.get("/system/health", async (c) => {
    const requestedHours = Number(c.req.query("hours") ?? 24);
    const historyHours = Number.isFinite(requestedHours)
      ? Math.max(1, Math.min(168, Math.round(requestedHours)))
      : 24;
    try {
      return c.json(
        await collectInstanceHealth(store, {
          historyHours,
          gatewayHealth: gatewayHealth ?? (() => probeGatewayHealth(process.env)),
        }),
      );
    } catch {
      return c.json({ error: "Instance health diagnostics unavailable" }, 503);
    }
  });
}
