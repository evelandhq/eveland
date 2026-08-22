import type { Store } from "@evelandhq/db";
import { workflowDispatcherHeartbeatSchema } from "./app-schemas.js";
import { isServiceRequest } from "./app-support.js";
import type { ApiApp, AppOptions } from "./app-types.js";

/**
 * The dispatcher readiness surface. systemd "active" and the stdout token
 * prove only that a process exec'd; this registration — written by the
 * dispatcher actually holding the ownership lock, through the authenticated
 * heartbeat — is what shared builds, cold activation and recovery entries gate
 * on.
 */

type DispatcherRouteStore = Pick<
  Store,
  "recordWorkflowDispatcherHeartbeat" | "getWorkflowDispatcherRegistration"
>;

export function registerWorkflowDispatcherRoutes(input: {
  app: ApiApp;
  store: DispatcherRouteStore;
  options: AppOptions;
}): void {
  const { app, store, options } = input;
  const serviceToken = () =>
    options.gatewayServiceToken ?? process.env.EVELAND_GATEWAY_SERVICE_TOKEN;

  app.post("/internal/workflow/dispatcher/heartbeat", async (c) => {
    if (!isServiceRequest(c.req.header("authorization"), serviceToken()))
      return c.json({ error: "Not found" }, 404);
    const parsed = workflowDispatcherHeartbeatSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: "Invalid dispatcher heartbeat" }, 400);
    const registration = await store.recordWorkflowDispatcherHeartbeat(parsed.data);
    return c.json({ registration });
  });

  app.get("/internal/workflow/dispatcher/registration", async (c) => {
    if (!isServiceRequest(c.req.header("authorization"), serviceToken()))
      return c.json({ error: "Not found" }, 404);
    const registration = await store.getWorkflowDispatcherRegistration();
    return c.json({ registration });
  });
}
