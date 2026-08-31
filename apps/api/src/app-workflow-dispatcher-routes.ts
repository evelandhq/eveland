import { permanentDeploymentActivationRefusal } from "@evelandhq/core/eve-compatibility";
import type { Store } from "@evelandhq/db";
import {
  workflowDispatcherHeartbeatSchema,
  workflowRecoveryPreflightSchema,
} from "./app-schemas.js";
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
  | "recordWorkflowDispatcherHeartbeat"
  | "getWorkflowDispatcherRegistration"
  | "getDeployment"
  | "getRelease"
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

  /**
   * Boot-recovery preflight (issue #433): which of these Deployments can
   * never activate again. The dispatcher filters those Deployments' runs out
   * of its recovery sweep instead of replaying each one into a guaranteed
   * dead letter per restart. Same predicate the worker's abandoned-run
   * reconciler settles on — deliberately narrower than the activation 409
   * set, because a transiently `failed` Deployment recovers on its next
   * activation and its runs must be replayed.
   */
  app.post("/internal/workflow/dispatcher/recovery-preflight", async (c) => {
    if (!isServiceRequest(c.req.header("authorization"), serviceToken()))
      return c.json({ error: "Not found" }, 404);
    const parsed = workflowRecoveryPreflightSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid recovery preflight" }, 400);
    const notActivatable: { deploymentId: string; reason: string }[] = [];
    for (const deploymentId of new Set(parsed.data.deploymentIds)) {
      const deployment = await store.getDeployment(deploymentId);
      const release = deployment ? await store.getRelease(deployment.releaseId) : null;
      const reason = permanentDeploymentActivationRefusal(deployment, release?.summary ?? null);
      if (reason !== null) notActivatable.push({ deploymentId, reason });
    }
    return c.json({ notActivatable });
  });

  app.get("/internal/workflow/dispatcher/registration", async (c) => {
    if (!isServiceRequest(c.req.header("authorization"), serviceToken()))
      return c.json({ error: "Not found" }, 404);
    const registration = await store.getWorkflowDispatcherRegistration();
    return c.json({ registration });
  });
}
