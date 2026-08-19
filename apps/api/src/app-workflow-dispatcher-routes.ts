import { resolveDispatcherHeartbeatTtlMs } from "@evelandhq/core/workflow-dispatch";
import type { Store } from "@evelandhq/db";
import { workflowDispatcherHeartbeatSchema } from "./app-schemas.js";
import { isServiceRequest } from "./app-support.js";
import type { ApiApp, AppOptions } from "./app-types.js";

/**
 * The dispatcher readiness surface. systemd "active" and the stdout token
 * prove only that a process exec'd; this registration — written by the
 * dispatcher actually holding the ownership lock, through the authenticated
 * heartbeat — is what shared builds, cold activation and recovery entries gate
 * on. The heartbeat response carries the desired state, which is how an
 * explicit, authenticated resume reaches a `ready_paused` dispatcher without
 * the dispatcher ever reading the control-plane database.
 */

type DispatcherRouteStore = Pick<
  Store,
  | "recordWorkflowDispatcherHeartbeat"
  | "getWorkflowDispatcherRegistration"
  | "setWorkflowDispatcherDesiredState"
>;

export function registerWorkflowDispatcherRoutes(input: {
  app: ApiApp;
  store: DispatcherRouteStore;
  options: AppOptions;
}): void {
  const { app, store, options } = input;
  const serviceToken = () =>
    options.gatewayServiceToken ?? process.env.EVELAND_GATEWAY_SERVICE_TOKEN;
  // The cutover operation this API instance serves, when it is a cutover API.
  const apiCutoverOperationId = () =>
    options.cutoverOperationId ??
    (process.env.EVELAND_PROCESS_MODE === "workflow-cutover"
      ? process.env.EVELAND_WORKFLOW_CUTOVER_OPERATION_ID
      : undefined);

  app.post("/internal/workflow/dispatcher/heartbeat", async (c) => {
    if (!isServiceRequest(c.req.header("authorization"), serviceToken()))
      return c.json({ error: "Not found" }, 404);
    const parsed = workflowDispatcherHeartbeatSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: "Invalid dispatcher heartbeat" }, 400);
    // A cutover API accepts only the Dispatcher serving its exact operation:
    // a normal-mode or stale-operation Dispatcher must not be able to
    // register, resume, or participate in activation through it.
    const expectedOperation = apiCutoverOperationId();
    if (expectedOperation !== undefined && parsed.data.cutoverOperationId !== expectedOperation) {
      return c.json(
        {
          error: `Dispatcher serves cutover operation ${String(parsed.data.cutoverOperationId)}, but this API serves ${expectedOperation}`,
        },
        409,
      );
    }
    const registration = await store.recordWorkflowDispatcherHeartbeat(parsed.data);
    return c.json({ desiredState: registration.desiredState });
  });

  app.get("/internal/workflow/dispatcher/registration", async (c) => {
    if (!isServiceRequest(c.req.header("authorization"), serviceToken()))
      return c.json({ error: "Not found" }, 404);
    const registration = await store.getWorkflowDispatcherRegistration();
    return c.json({ registration });
  });

  app.post("/internal/workflow/dispatcher/resume", async (c) => {
    if (!isServiceRequest(c.req.header("authorization"), serviceToken()))
      return c.json({ error: "Not found" }, 404);
    const registration = await store.getWorkflowDispatcherRegistration();
    if (!registration) return c.json({ error: "No dispatcher registration exists" }, 404);
    const age = Date.now() - new Date(registration.lastHeartbeatAt).getTime();
    if (age > resolveDispatcherHeartbeatTtlMs(process.env)) {
      return c.json(
        { error: "workflow_unavailable: the dispatcher registration heartbeat is stale" },
        409,
      );
    }
    if (registration.state !== "ready_paused") {
      return c.json(
        { error: `Dispatcher is ${registration.state}; only ready_paused can be resumed` },
        409,
      );
    }
    // Resume is scoped to the operation this API serves — never a generic
    // "resume whatever dispatcher happens to be registered".
    const expectedOperation = apiCutoverOperationId();
    if (expectedOperation !== undefined && registration.cutoverOperationId !== expectedOperation) {
      return c.json(
        {
          error: `Registered dispatcher serves cutover operation ${String(registration.cutoverOperationId)}, but this API serves ${expectedOperation}`,
        },
        409,
      );
    }
    const resumed = await store.setWorkflowDispatcherDesiredState(registration.instanceId, "ready");
    return c.json({ registration: resumed });
  });
}
